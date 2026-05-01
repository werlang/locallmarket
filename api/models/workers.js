import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';
import { usersModel } from './users.js';

const API_KEY_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_MIN_TPS = 5;
const DEFAULT_MAX_PRICE = 100;

export class WorkersModel {
    constructor({ mysql = Mysql, users = usersModel } = {}) {
        this.mysql = mysql;
        this.users = users;
    }

    /**
     * Registers or refreshes a worker row from a WebSocket connection event.
     * The worker must authenticate with a valid API key and provide its model,
     * rated tps, and price so consumers can discover it via the public listing.
     *
     * @param {{ workerId: string, apiKey: string, model: string, tps: number, price: number }} input
     * @returns {Promise<{ worker: object, user: object }>}
     */
    async bindConnectedWorker(input) {
        const workerId = this.#parseWorkerId(input?.workerId);
        const apiKey = this.#parseApiKey(input?.apiKey);
        const model = this.#parseModel(input?.model);
        const tps = this.#parseTps(input?.tps);
        const price = this.#parsePrice(input?.price);

        const owner = await this.users.getByApiKeyOrNull(apiKey);
        if (!owner) throw new HttpError(401, 'Invalid API key.');

        const existing = await this.getByIdOrNull(workerId);
        if (existing && existing.userId !== owner.id)
            throw new HttpError(403, 'Worker identifier already belongs to another user.');

        await this.mysql.upsert('workers', {
            id: workerId,
            user_id: owner.id,
            model,
            tps,
            price,
            status: 'available',
            connected_at: this.mysql.raw('NOW()'),
            disconnected_at: null,
            last_seen_at: this.mysql.raw('NOW()')
        }, {
            conflictFields: ['id'],
            updateFields: ['user_id', 'model', 'tps', 'price', 'status', 'connected_at', 'disconnected_at', 'last_seen_at']
        });

        const worker = await this.getByIdOrNull(workerId);
        if (!worker) throw new HttpError(500, 'Worker registration could not be confirmed. Please retry.');
        if (worker.userId !== owner.id) throw new HttpError(403, 'Worker identifier already belongs to another user.');

        return { worker, user: owner };
    }

    /**
     * Marks a worker as disconnected when its WebSocket session closes.
     * @param {string} workerId
     */
    async markDisconnected(workerId) {
        const id = this.#parseWorkerId(workerId);
        await this.mysql.update('workers', {
            status: 'disconnected',
            disconnected_at: this.mysql.raw('NOW()'),
            last_seen_at: this.mysql.raw('NOW()')
        }, { id });
    }

    /**
     * Atomically transitions a worker from 'available' to 'busy'.
     * Returns true when the update lands, false when the worker was already
     * grabbed by a concurrent request (optimistic locking via WHERE status='available').
     *
     * @param {string} workerId
     * @returns {Promise<boolean>}
     */
    async markBusy(workerId) {
        const id = this.#parseWorkerId(workerId);
        const result = await this.mysql.update('workers', { status: 'busy' }, { id, status: 'available' });
        return result?.affectedRows > 0;
    }

    /**
     * Transitions a worker back to 'available' after a job finishes.
     * @param {string} workerId
     */
    async markAvailable(workerId) {
        const id = this.#parseWorkerId(workerId);
        await this.mysql.update('workers', {
            status: 'available',
            last_seen_at: this.mysql.raw('NOW()')
        }, { id });
    }

    /**
     * Updates the observed tokens-per-second for a worker after a completed job.
     * @param {{ workerId: string, usage: object, startedAtMs: number, completedAtMs?: number }} input
     * @returns {Promise<number | null>}
     */
    async updatePerformanceTps(input) {
        const workerId = this.#parseWorkerId(input?.workerId);
        const observedTps = computeObservedTps({
            usage: input?.usage,
            startedAtMs: input?.startedAtMs,
            completedAtMs: input?.completedAtMs ?? Date.now()
        });

        if (observedTps === null) return null;

        await this.mysql.update('workers', { tps: observedTps }, { id: workerId });

        return observedTps;
    }

    /**
     * Returns the first worker that is currently available for the requested model
     * and satisfies the optional price/tps constraints.
     * Candidates are filtered by DB status='available' first, then runtime-connectivity
     * is confirmed via the streamRouter.
     *
     * @param {string} model
     * @param {{ maxPrice?: number | null, minTps?: number | null, streamRouter?: object }} [options]
     * @returns {Promise<{ id: string, userId: string, model: string, tps: number, price: number } | null>}
     */
    async findFirstAvailableByModel(model, { maxPrice, minTps, streamRouter } = {}) {
        const normalizedModel = typeof model === 'string' ? model.trim() : '';
        if (!normalizedModel) throw new HttpError(400, 'model must be a non-empty string.');

        const effectiveMaxPrice = maxPrice == null ? DEFAULT_MAX_PRICE : maxPrice;
        const effectiveMinTps = minTps == null ? DEFAULT_MIN_TPS : minTps;

        const filter = {
            model: normalizedModel,
            status: 'available',
            price: this.mysql.lte(effectiveMaxPrice),
            tps: this.mysql.gte(effectiveMinTps)
        };

        const candidates = await this.mysql.find('workers', {
            filter,
            view: ['id', 'user_id', 'model', 'tps', 'price', 'status'],
            opt: { limit: 100, order: { price: 1, tps: -1 } }
        });

        for (const row of candidates) {
            const worker = mapWorkerRow(row);

            if (maxPrice != null && worker.price > maxPrice) continue;
            if (minTps != null && worker.tps < minTps) continue;

            // Confirm runtime connectivity when a stream router is available
            if (streamRouter && !streamRouter.isWorkerAvailable(worker.id)) continue;

            return worker;
        }

        return null;
    }

    /**
     * Lists all workers owned by the given user, enriched with runtime state.
     * @param {string} ownerId
     * @param {{ runtimeWorkers?: Array }} [options]
     */
    async listPoolByOwner(ownerId, { runtimeWorkers = [] } = {}) {
        const userId = this.#parseOwnerId(ownerId);
        const workerRows = await this.mysql.find('workers', {
            filter: { user_id: userId },
            view: ['id', 'user_id', 'model', 'tps', 'price', 'status', 'connected_at', 'disconnected_at', 'last_seen_at', 'created_at', 'updated_at'],
            opt: { order: { created_at: 1 } }
        });

        const runtimeByWorkerId = new Map();
        for (const rw of runtimeWorkers) {
            if (rw && typeof rw.id === 'string' && rw.id.trim().length > 0)
                runtimeByWorkerId.set(rw.id.trim(), rw);
        }

        return workerRows.map((row) => mergeRuntimeState(mapWorkerRow(row), runtimeByWorkerId.get(row.id) || null));
    }

    /**
     * Lists all workers across all owners, enriched with runtime state.
     * @param {{ runtimeWorkers?: Array }} [options]
     */
    async listPool({ runtimeWorkers = [] } = {}) {
        const workerRows = await this.mysql.find('workers', {
            view: ['id', 'user_id', 'model', 'tps', 'price', 'status', 'connected_at', 'disconnected_at', 'last_seen_at', 'created_at', 'updated_at'],
            opt: { order: { created_at: 1 } }
        });

        const runtimeByWorkerId = new Map();
        for (const rw of runtimeWorkers) {
            if (rw && typeof rw.id === 'string' && rw.id.trim().length > 0)
                runtimeByWorkerId.set(rw.id.trim(), rw);
        }

        return workerRows.map((row) => mergeRuntimeState(mapWorkerRow(row), runtimeByWorkerId.get(row.id) || null));
    }

    /**
     * Lists all workers that are currently available for public consumption.
     * Only workers with status='available' and a non-null model/price/tps are included.
     */
    async listPublic() {
        const rows = await this.mysql.find('workers', {
            filter: { status: 'available' },
            view: ['id', 'model', 'tps', 'price', 'status', 'last_seen_at', 'created_at', 'updated_at'],
            opt: { order: { price: 1, tps: -1 } }
        });

        return rows
            .filter((row) => row.model && row.tps != null && row.price != null)
            .map((row) => ({
                id: row.id,
                model: row.model,
                tps: Number(row.tps),
                price: Number(row.price),
                status: row.status,
                lastSeenAt: row.last_seen_at,
                createdAt: row.created_at,
                updatedAt: row.updated_at
            }));
    }

    /**
     * Fetches a single worker by ID, or null if not found.
     * @param {string} workerId
     */
    async getByIdOrNull(workerId) {
        const id = this.#parseWorkerId(workerId);
        const row = await this.mysql.findOne('workers', {
            filter: { id },
            view: ['id', 'user_id', 'model', 'tps', 'price', 'status', 'connected_at', 'disconnected_at', 'last_seen_at', 'created_at', 'updated_at'],
            opt: { limit: 1 }
        });
        return row ? mapWorkerRow(row) : null;
    }

    #parseWorkerId(workerId) {
        if (typeof workerId !== 'string' || workerId.trim().length < 1 || workerId.trim().length > 128)
            throw new HttpError(400, 'workerId must be a non-empty string up to 128 characters.');
        return workerId.trim();
    }
    #parseApiKey(apiKey) {
        if (typeof apiKey !== 'string') throw new HttpError(401, 'Worker apiKey is required.');
        const normalized = apiKey.trim();
        if (!API_KEY_PATTERN.test(normalized)) throw new HttpError(401, 'Invalid API key.');
        return normalized;
    }
    #parseOwnerId(ownerId) {
        if (typeof ownerId !== 'string' || ownerId.trim().length < 1 || ownerId.trim().length > 128)
            throw new HttpError(400, 'ownerId must be a non-empty string up to 128 characters.');
        return ownerId.trim();
    }
    #parseModel(model) {
        if (typeof model !== 'string' || model.trim().length < 1 || model.trim().length > 128)
            throw new HttpError(400, 'model must be a non-empty string up to 128 characters.');
        return model.trim();
    }
    #parseTps(tps) {
        const value = Number(tps);
        if (!Number.isInteger(value) || value < 1)
            throw new HttpError(400, 'tps must be a positive integer.');
        return value;
    }
    #parsePrice(price) {
        const value = Number(price);
        if (!Number.isFinite(value) || value <= 0)
            throw new HttpError(400, 'price must be a positive number.');
        return parseFloat(value.toFixed(6));
    }
}

export const workersModel = new WorkersModel();

function mapWorkerRow(row) {
    return {
        id: row.id,
        userId: row.user_id,
        model: row.model ?? null,
        tps: row.tps != null ? Number(row.tps) : null,
        price: row.price != null ? Number(row.price) : null,
        status: row.status,
        connectedAt: row.connected_at ?? null,
        disconnectedAt: row.disconnected_at ?? null,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * Merges persisted worker data with optional runtime presence info from the stream router.
 */
function mergeRuntimeState(worker, runtimeWorker) {
    const connected = Boolean(runtimeWorker?.connected);
    const available = connected ? Boolean(runtimeWorker?.available) : false;
    const activeJobId = connected && typeof runtimeWorker?.activeJobId === 'string'
        ? runtimeWorker.activeJobId
        : null;

    const runtimeStatus = connected
        ? (activeJobId ? 'busy' : 'available')
        : worker.status;

    return { ...worker, connected, available, activeJobId, status: runtimeStatus };
}

function computeObservedTps({ usage, startedAtMs, completedAtMs }) {
    const completionTokens = normalizeCompletionTokens(usage);
    if (!Number.isFinite(completionTokens) || completionTokens <= 0) return null;
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs <= startedAtMs) return null;
    const elapsedSeconds = (completedAtMs - startedAtMs) / 1000;
    const observedTps = Math.round(completionTokens / elapsedSeconds);
    if (!Number.isFinite(observedTps) || observedTps < 1) return null;
    return observedTps;
}

function normalizeCompletionTokens(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens);
    if (Number.isFinite(completionTokens) && completionTokens > 0) return completionTokens;
    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);
    const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens);
    if (Number.isFinite(totalTokens) && Number.isFinite(promptTokens) && totalTokens > promptTokens)
        return totalTokens - promptTokens;
    return 0;
}
