import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';
import { usersModel } from './users.js';

const API_KEY_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Applies worker ownership and lifecycle business rules.
 */
export class WorkersModel {
    /**
     * @param {{ mysql?: typeof Mysql, users?: Pick<typeof usersModel, 'getByApiKeyOrNull'> }} [options]
     */
    constructor({ mysql = Mysql, users = usersModel } = {}) {
        this.mysql = mysql;
        this.users = users;
    }

    /**
     * Resolves a worker registration using the owner API key and persists ownership.
     * @param {{ workerId: string, apiKey: string }} input
     */
    async bindConnectedWorker(input) {
        const workerId = this.#parseWorkerId(input?.workerId);
        const apiKey = this.#parseApiKey(input?.apiKey);
        const owner = await this.users.getByApiKeyOrNull(apiKey);

        if (!owner) {
            throw new HttpError(401, 'Invalid API key.');
        }

        const existing = await this.getByIdOrNull(workerId);
        if (existing && existing.userId !== owner.id) {
            throw new HttpError(403, 'Worker identifier already belongs to another user.');
        }

        await this.mysql.upsert('workers', {
            id: workerId,
            user_id: owner.id,
            status: 'connected',
            connected_at: this.mysql.raw('NOW()'),
            disconnected_at: null,
            last_seen_at: this.mysql.raw('NOW()')
        }, {
            conflictFields: ['id'],
            updateFields: ['status', 'connected_at', 'disconnected_at', 'last_seen_at']
        });

        const worker = await this.getByIdOrNull(workerId);
        if (!worker) {
            throw new HttpError(500, 'Worker registration could not be confirmed. Please retry.');
        }

        // Re-validate owner after persistence to avoid race-condition confusion.
        if (worker.userId !== owner.id) {
            throw new HttpError(403, 'Worker identifier already belongs to another user.');
        }

        return {
            worker,
            user: owner
        };
    }

    /**
     * Marks a worker as disconnected in persistence.
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
     * Persists observed worker throughput to the currently available offer rows.
     * Returns the computed TPS, or null when metrics are insufficient.
     *
     * @param {{ workerId: string, model: string, usage?: any, startedAtMs: number, completedAtMs?: number }} input
     * @returns {Promise<number | null>}
     */
    async updatePerformanceTps(input) {
        const workerId = this.#parseWorkerId(input?.workerId);
        const model = this.#parseModel(input?.model);
        const observedTps = computeObservedTps({
            usage: input?.usage,
            startedAtMs: input?.startedAtMs,
            completedAtMs: input?.completedAtMs ?? Date.now()
        });

        if (observedTps === null) {
            return null;
        }

        await this.mysql.update('orders', {
            tps: observedTps
        }, {
            worker_id: workerId,
            model,
            is_available: 1,
            is_consumed: 0
        });

        return observedTps;
    }

    /**
     * Lists the owner-scoped worker pool, including current offer details and runtime connectivity state.
     * @param {string} ownerId
     * @param {{ runtimeWorkers?: Array<{ id: string, connected?: boolean, available?: boolean, activeJobId?: string | null }> }} [options]
     */
    async listPoolByOwner(ownerId, { runtimeWorkers = [] } = {}) {
        const userId = this.#parseOwnerId(ownerId);

        const workerRows = await this.mysql.find('workers', {
            filter: { user_id: userId },
            view: [
                'id',
                'user_id',
                'status',
                'connected_at',
                'disconnected_at',
                'last_seen_at',
                'created_at',
                'updated_at'
            ],
            opt: { order: { created_at: 1 } }
        });

        const offerRows = await this.mysql.find('orders', {
            filter: {
                user_id: userId,
                is_available: 1,
                is_consumed: 0
            },
            view: [
                'id',
                'worker_id',
                'model',
                'price',
                'tps',
                'is_available',
                'is_consumed',
                'created_at',
                'updated_at'
            ],
            opt: { order: { updated_at: -1 } }
        });

        const latestOfferByWorkerId = new Map();
        for (const row of offerRows) {
            if (!latestOfferByWorkerId.has(row.worker_id)) {
                latestOfferByWorkerId.set(row.worker_id, row);
            }
        }

        const runtimeByWorkerId = new Map();
        for (const runtimeWorker of runtimeWorkers) {
            if (runtimeWorker && typeof runtimeWorker.id === 'string' && runtimeWorker.id.trim().length > 0) {
                runtimeByWorkerId.set(runtimeWorker.id.trim(), runtimeWorker);
            }
        }

        return workerRows.map((row) => mapPoolWorkerRow({
            workerRow: row,
            offerRow: latestOfferByWorkerId.get(row.id) || null,
            runtimeWorker: runtimeByWorkerId.get(row.id) || null
        }));
    }

    /**
     * @param {string} workerId
     */
    async getByIdOrNull(workerId) {
        const id = this.#parseWorkerId(workerId);
        const row = await this.mysql.findOne('workers', {
            filter: { id },
            view: [
                'id',
                'user_id',
                'status',
                'connected_at',
                'disconnected_at',
                'last_seen_at',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return row ? mapWorkerRow(row) : null;
    }

    /**
     * @param {unknown} workerId
     */
    #parseWorkerId(workerId) {
        if (typeof workerId !== 'string' || workerId.trim().length < 1 || workerId.trim().length > 128) {
            throw new HttpError(400, 'workerId must be a non-empty string up to 128 characters.');
        }

        return workerId.trim();
    }

    /**
     * @param {unknown} apiKey
     */
    #parseApiKey(apiKey) {
        if (typeof apiKey !== 'string') {
            throw new HttpError(401, 'Worker apiKey is required.');
        }

        const normalized = apiKey.trim();
        if (!API_KEY_PATTERN.test(normalized)) {
            throw new HttpError(401, 'Invalid API key.');
        }

        return normalized;
    }

    /**
     * @param {unknown} ownerId
     */
    #parseOwnerId(ownerId) {
        if (typeof ownerId !== 'string' || ownerId.trim().length < 1 || ownerId.trim().length > 128) {
            throw new HttpError(400, 'ownerId must be a non-empty string up to 128 characters.');
        }

        return ownerId.trim();
    }

    /**
     * @param {unknown} model
     */
    #parseModel(model) {
        if (typeof model !== 'string' || model.trim().length < 1 || model.trim().length > 128) {
            throw new HttpError(400, 'model must be a non-empty string up to 128 characters.');
        }

        return model.trim();
    }
}

export const workersModel = new WorkersModel();

/**
 * @param {{
 *  id: string,
 *  user_id: string,
 *  status: string,
 *  connected_at: Date | string,
 *  disconnected_at: Date | string | null,
 *  last_seen_at: Date | string,
 *  created_at: Date | string,
 *  updated_at: Date | string
 * }} row
 */
function mapWorkerRow(row) {
    return {
        id: row.id,
        userId: row.user_id,
        status: row.status,
        connectedAt: row.connected_at,
        disconnectedAt: row.disconnected_at,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * @param {{
 *  workerRow: {
 *      id: string,
 *      user_id: string,
 *      status: string,
 *      connected_at: Date | string,
 *      disconnected_at: Date | string | null,
 *      last_seen_at: Date | string,
 *      created_at: Date | string,
 *      updated_at: Date | string
 *  },
 *  offerRow: {
 *      id: number,
 *      worker_id: string,
 *      model: string,
 *      price: number | string,
 *      tps: number,
 *      is_available: number,
 *      is_consumed: number,
 *      created_at: Date | string,
 *      updated_at: Date | string
 *  } | null,
 *  runtimeWorker: {
 *      id: string,
 *      connected?: boolean,
 *      available?: boolean,
 *      activeJobId?: string | null
 *  } | null
 * }} input
 */
function mapPoolWorkerRow({ workerRow, offerRow, runtimeWorker }) {
    const connected = Boolean(runtimeWorker?.connected);
    const available = connected ? Boolean(runtimeWorker?.available) : false;
    const activeJobId = connected && typeof runtimeWorker?.activeJobId === 'string'
        ? runtimeWorker.activeJobId
        : null;
    const status = connected
        ? (activeJobId ? 'busy' : 'connected')
        : workerRow.status;

    return {
        id: workerRow.id,
        userId: workerRow.user_id,
        status,
        connected,
        available,
        activeJobId,
        model: offerRow ? offerRow.model : null,
        price: offerRow ? Number(offerRow.price) : null,
        tps: offerRow ? Number(offerRow.tps) : null,
        offerId: offerRow ? Number(offerRow.id) : null,
        connectedAt: workerRow.connected_at,
        disconnectedAt: workerRow.disconnected_at,
        lastSeenAt: workerRow.last_seen_at,
        createdAt: workerRow.created_at,
        updatedAt: workerRow.updated_at
    };
}

/**
 * Computes an integer TPS estimate from completion usage and elapsed job time.
 *
 * @param {{ usage?: any, startedAtMs: number, completedAtMs: number }} input
 * @returns {number | null}
 */
function computeObservedTps({ usage, startedAtMs, completedAtMs }) {
    const completionTokens = normalizeCompletionTokens(usage);
    if (!Number.isFinite(completionTokens) || completionTokens <= 0) {
        return null;
    }

    if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs <= startedAtMs) {
        return null;
    }

    const elapsedSeconds = (completedAtMs - startedAtMs) / 1000;
    const observedTps = Math.round(completionTokens / elapsedSeconds);

    if (!Number.isFinite(observedTps) || observedTps < 1) {
        return null;
    }

    return observedTps;
}

/**
 * Extracts completion-token usage with fallback across snake_case/camelCase shapes.
 *
 * @param {any} usage
 * @returns {number}
 */
function normalizeCompletionTokens(usage) {
    if (!usage || typeof usage !== 'object') {
        return 0;
    }

    const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens);
    if (Number.isFinite(completionTokens) && completionTokens > 0) {
        return completionTokens;
    }

    const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);
    const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens);

    if (Number.isFinite(totalTokens) && Number.isFinite(promptTokens) && totalTokens > promptTokens) {
        return totalTokens - promptTokens;
    }

    return 0;
}
