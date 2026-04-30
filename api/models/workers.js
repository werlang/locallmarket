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
