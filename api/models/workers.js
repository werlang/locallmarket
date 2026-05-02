import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';
import { usersModel } from './users.js';
import { createHmac, timingSafeEqual } from 'crypto';

const API_KEY_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_MIN_TPS = 5;
const DEFAULT_MAX_PRICE = 100;
const WORKER_TOKEN_VERSION = 'w1';
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const SERVED_REQUESTS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SERVED_REQUESTS_TARGET_24H = 1000;

function getWorkerTokenSecret() {
    return process.env.ENCRYPTION_SECRET
}

export class WorkersModel {
    constructor({ mysql = Mysql, users = usersModel, now = () => Date.now() } = {}) {
        this.mysql = mysql;
        this.users = users;
        this.now = now;
    }

    /**
     * Registers or refreshes a worker row from a WebSocket connection event.
     * The worker must authenticate with a valid API key and provide its model,
     * rated tps, and price so consumers can discover it via the public listing.
     *
         * @param {{ workerId: string, token?: string, apiKey: string, model: string, tps: number, price: number }} input
         * @returns {Promise<{ worker: object, user: object, identity: { workerId: string, token: string | null, ownerId: string } }>}
     */
    async bindConnectedWorker(input) {
        const requestedWorkerId = this.#parseWorkerId(input?.workerId);
        const token = this.#normalizeToken(input?.token);
        const apiKey = this.#parseApiKey(input?.apiKey);
        const model = this.#parseModel(input?.model);
        const tps = this.#parseTps(input?.tps);
        const price = this.#parsePrice(input?.price);

        const owner = await this.users.getByApiKeyOrNull(apiKey);
        if (!owner) throw new HttpError(401, 'Invalid API key.');

        const tokenWorker = token
            ? await this.getByTokenOrNull(token, { expectedOwnerId: owner.id })
            : null;

        const workerId = tokenWorker?.id ?? requestedWorkerId;

        const existingRow = await this.#findLifecycleRowByIdOrNull(workerId);
        if (existingRow && existingRow.user_id !== owner.id)
            throw new HttpError(403, 'Worker identifier already belongs to another user.');

        const lifecycleState = this.#computeLifecycleStateForConnect(existingRow);

        await this.mysql.upsert('workers', {
            id: workerId,
            user_id: owner.id,
            model,
            tps,
            price,
            status: 'available',
            connected_at: this.mysql.raw('NOW()'),
            disconnected_at: null,
            last_seen_at: this.mysql.raw('NOW()'),
            uptime_window_started_at: lifecycleState.uptimeWindowStartedAt,
            uptime_24h_seconds: lifecycleState.uptimeSeconds,
            served_window_started_at: lifecycleState.servedWindowStartedAt,
            served_requests_24h: lifecycleState.servedRequests,
            reputation: lifecycleState.reputation
        }, {
            conflictFields: ['id'],
            updateFields: ['model', 'tps', 'price', 'status', 'connected_at', 'disconnected_at', 'last_seen_at', 'uptime_window_started_at', 'uptime_24h_seconds', 'served_window_started_at', 'served_requests_24h', 'reputation']
        });

        const worker = await this.getByIdOrNull(workerId);
        if (!worker) throw new HttpError(500, 'Worker registration could not be confirmed. Please retry.');
        if (worker.userId !== owner.id) throw new HttpError(403, 'Worker identifier already belongs to another user.');

        const issuedToken = tokenWorker
            ? token
            : this.#createToken({ workerId, ownerId: owner.id });

        return {
            worker,
            user: owner,
            identity: {
                workerId,
                token: issuedToken,
                ownerId: owner.id
            }
        };
    }

    /**
     * Resolves a worker row from a signed identity token.
     * @param {string | null | undefined} token
     * @param {{ expectedOwnerId?: string }} [options]
     * @returns {Promise<object | null>}
     */
    async getByTokenOrNull(token, { expectedOwnerId } = {}) {
        const normalizedToken = this.#normalizeToken(token);
        if (!normalizedToken) {
            return null;
        }

        const claims = this.#decodeToken(normalizedToken);
        if (!claims) {
            return null;
        }

        if (expectedOwnerId && claims.ownerId !== expectedOwnerId) {
            return null;
        }

        const worker = await this.getByIdOrNull(claims.workerId);
        if (!worker) {
            return null;
        }

        if (worker.userId !== claims.ownerId) {
            return null;
        }

        return worker;
    }

    /**
     * Marks a worker as disconnected when its WebSocket session closes.
     * @param {string} workerId
     */
    async markDisconnected(workerId) {
        const id = this.#parseWorkerId(workerId);

        const existingRow = await this.#findLifecycleRowByIdOrNull(id);
        const lifecycleState = this.#computeLifecycleState(existingRow);

        await this.mysql.update('workers', {
            status: 'disconnected',
            disconnected_at: this.mysql.raw('NOW()'),
            last_seen_at: this.mysql.raw('NOW()'),
            uptime_window_started_at: lifecycleState.uptimeWindowStartedAt,
            uptime_24h_seconds: lifecycleState.uptimeSeconds,
            served_window_started_at: lifecycleState.servedWindowStartedAt,
            served_requests_24h: lifecycleState.servedRequests,
            reputation: lifecycleState.reputation
        }, { id });
    }

    /**
     * Increments the worker's served-request count inside the rolling 24h window.
     * @param {string} workerId
     */
    async incrementServedRequests(workerId) {
        const id = this.#parseWorkerId(workerId);
        const existingRow = await this.#findLifecycleRowByIdOrNull(id);
        const lifecycleState = this.#computeLifecycleState(existingRow);
        const nextServedRequests = lifecycleState.servedRequests + 1;

        await this.mysql.update('workers', {
            last_seen_at: this.mysql.raw('NOW()'),
            uptime_window_started_at: lifecycleState.uptimeWindowStartedAt,
            uptime_24h_seconds: lifecycleState.uptimeSeconds,
            served_window_started_at: lifecycleState.servedWindowStartedAt,
            served_requests_24h: nextServedRequests,
            reputation: computeReputation({
                uptimeSeconds: lifecycleState.uptimeSeconds,
                servedRequests: nextServedRequests
            })
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

    async #findLifecycleRowByIdOrNull(workerId) {
        return this.mysql.findOne('workers', {
            filter: { id: workerId },
            view: ['id', 'user_id', 'status', 'connected_at', 'uptime_window_started_at', 'uptime_24h_seconds', 'served_window_started_at', 'served_requests_24h'],
            opt: { limit: 1 }
        });
    }

    #computeLifecycleStateForConnect(existingRow) {
        if (!existingRow) {
            return {
                uptimeWindowStartedAt: this.mysql.raw('NOW()'),
                uptimeSeconds: 0,
                servedWindowStartedAt: this.mysql.raw('NOW()'),
                servedRequests: 0,
                reputation: 0
            };
        }

        return this.#computeLifecycleState(existingRow);
    }

    #computeLifecycleState(existingRow) {
        const uptimeState = this.#computeUptimeState(existingRow);
        const servedRequestsState = this.#computeServedRequestsState(existingRow);

        return {
            uptimeWindowStartedAt: uptimeState.windowStartedAt,
            uptimeSeconds: uptimeState.uptimeSeconds,
            servedWindowStartedAt: servedRequestsState.windowStartedAt,
            servedRequests: servedRequestsState.servedRequests,
            reputation: computeReputation({
                uptimeSeconds: uptimeState.uptimeSeconds,
                servedRequests: servedRequestsState.servedRequests
            })
        };
    }

    #computeUptimeState(existingRow) {
        const nowMs = this.now();
        const fallbackWindowStartMs = nowMs;

        let windowStartedAtMs = parseTimestampMs(existingRow?.uptime_window_started_at)
            ?? parseTimestampMs(existingRow?.connected_at)
            ?? fallbackWindowStartMs;

        let uptimeSeconds = normalizeNonNegativeInt(existingRow?.uptime_24h_seconds);

        if (nowMs - windowStartedAtMs >= UPTIME_WINDOW_MS) {
            windowStartedAtMs = nowMs;
            uptimeSeconds = 0;
        }

        if (isConnectedStatus(existingRow?.status)) {
            const connectedAtMs = parseTimestampMs(existingRow?.connected_at);
            if (connectedAtMs != null) {
                const countedStartMs = Math.max(connectedAtMs, windowStartedAtMs);
                if (nowMs > countedStartMs) {
                    uptimeSeconds += Math.floor((nowMs - countedStartMs) / 1000);
                }
            }
        }

        const elapsedWithinWindowSeconds = Math.max(0, Math.floor((nowMs - windowStartedAtMs) / 1000));
        const normalizedUptimeSeconds = Math.max(0, Math.min(uptimeSeconds, elapsedWithinWindowSeconds, UPTIME_WINDOW_MS / 1000));

        return {
            windowStartedAt: new Date(windowStartedAtMs),
            uptimeSeconds: normalizedUptimeSeconds
        };
    }

    #computeServedRequestsState(existingRow) {
        const nowMs = this.now();
        const fallbackWindowStartMs = nowMs;

        let windowStartedAtMs = parseTimestampMs(existingRow?.served_window_started_at)
            ?? fallbackWindowStartMs;

        let servedRequests = normalizeNonNegativeInt(existingRow?.served_requests_24h);

        if (nowMs - windowStartedAtMs >= SERVED_REQUESTS_WINDOW_MS) {
            windowStartedAtMs = nowMs;
            servedRequests = 0;
        }

        return {
            windowStartedAt: new Date(windowStartedAtMs),
            servedRequests
        };
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
    #normalizeToken(token) {
        if (typeof token !== 'string') {
            return null;
        }

        const normalized = token.trim();

        if (normalized.length < 1 || normalized.length > 256) {
            return null;
        }

        return normalized;
    }
    #createToken({ workerId, ownerId }) {
        const payload = Buffer.from(JSON.stringify({ workerId, ownerId }), 'utf8').toString('base64url');
        const signature = this.#signTokenPayload(payload);
        return `${WORKER_TOKEN_VERSION}.${payload}.${signature}`;
    }
    #decodeToken(token) {
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== WORKER_TOKEN_VERSION) {
            return null;
        }

        const payload = parts[1];
        const signature = parts[2];
        const expectedSignature = this.#signTokenPayload(payload);
        if (!this.#isValidSignature(signature, expectedSignature)) {
            return null;
        }

        try {
            const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (typeof parsed?.workerId !== 'string' || parsed.workerId.trim().length < 1) {
                return null;
            }

            if (typeof parsed?.ownerId !== 'string' || parsed.ownerId.trim().length < 1) {
                return null;
            }

            return {
                workerId: parsed.workerId.trim(),
                ownerId: parsed.ownerId.trim()
            };
        } catch {
            return null;
        }
    }
    #signTokenPayload(payload) {
        return createHmac('sha256', getWorkerTokenSecret())
            .update(payload, 'utf8')
            .digest('base64url');
    }
    #isValidSignature(received, expected) {
        if (typeof received !== 'string' || typeof expected !== 'string') {
            return false;
        }

        const receivedBuffer = Buffer.from(received, 'utf8');
        const expectedBuffer = Buffer.from(expected, 'utf8');
        if (receivedBuffer.length !== expectedBuffer.length) {
            return false;
        }

        return timingSafeEqual(receivedBuffer, expectedBuffer);
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

function parseTimestampMs(value) {
    if (value == null) {
        return null;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNonNegativeInt(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }

    return Math.floor(parsed);
}

function isConnectedStatus(status) {
    return status === 'available' || status === 'busy';
}

function computeReputation({ uptimeSeconds, servedRequests }) {
    const uptimeScore = computeUptimeScore(uptimeSeconds);
    const servedRequestsScore = computeServedRequestsScore(servedRequests);
    return Number((uptimeScore + servedRequestsScore).toFixed(6));
}

function computeUptimeScore(uptimeSeconds) {
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds <= 0) {
        return 0;
    }

    const ratio = uptimeSeconds / (UPTIME_WINDOW_MS / 1000);
    return Number((ratio * 100).toFixed(6));
}

function computeServedRequestsScore(servedRequests) {
    if (!Number.isFinite(servedRequests) || servedRequests <= 0) {
        return 0;
    }

    const normalizedServedRequests = Math.floor(servedRequests);
    const ratio = Math.min(normalizedServedRequests, SERVED_REQUESTS_TARGET_24H) / SERVED_REQUESTS_TARGET_24H;
    return Number((ratio * 100).toFixed(6));
}
