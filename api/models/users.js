import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';

/**
 * Applies user business rules on top of persistence drivers.
 */
export class UsersModel {
    /**
     * Registers a new API user by external identifier.
     * @param {{ externalId: string, name?: string, email?: string }} input
     */
    async register(input) {
        const existing = await this.getByExternalIdOrNull(input.externalId);
        if (existing) {
            throw new HttpError(409, 'A user with this externalId already exists.');
        }

        try {
            const record = {
                external_id: input.externalId,
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.email !== undefined ? { email: input.email } : {})
            };
            const [result] = await Mysql.insert('users', record);
            return this.getById(result.insertId);
        } catch (error) {
            if (isDuplicateEntryError(error)) {
                throw new HttpError(409, 'A user with this identity already exists.');
            }

            throw error;
        }
    }

    /**
     * Gets a user profile by external identifier.
     * @param {string} externalId
     */
    async getByExternalId(externalId) {
        const user = await this.getByExternalIdOrNull(externalId);
        if (!user) {
            throw new HttpError(404, 'User not found.');
        }

        return user;
    }

    /**
     * Lists users using pagination options.
     * @param {{ limit: number, offset: number }} options
     */
    async list(options) {
        const users = await Mysql.find('users', {
            view: [
                'id',
                'external_id',
                'name',
                'email',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: {
                limit: options.limit,
                skip: options.offset,
                order: { id: -1 }
            }
        });

        return users.map(mapUserRow);
    }

    /**
     * Updates mutable user profile fields.
     * @param {string} externalId
     * @param {{ name?: string, email?: string }} input
     */
    async updateByExternalId(externalId, input) {
        const user = await this.getByExternalId(externalId);
        const updateData = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {})
        };

        try {
            await Mysql.update('users', updateData, user.id);
            return this.getById(user.id);
        } catch (error) {
            if (isDuplicateEntryError(error)) {
                throw new HttpError(409, 'Email already in use by another user.');
            }

            throw error;
        }
    }

    /**
     * Adds credits to an existing user account.
     * @param {string} externalId
     * @param {number} amount
     */
    async rechargeByExternalId(externalId, amount) {
        const user = await this.getByExternalId(externalId);
        await Mysql.update('users', { credits: { inc: amount } }, user.id);
        return this.getById(user.id);
    }

    /**
     * Deletes an existing user account.
     * @param {string} externalId
     */
    async deleteByExternalId(externalId) {
        const user = await this.getByExternalId(externalId);
        await Mysql.delete('users', user.id);
    }

    /**
     * @param {number} id
     */
    async getById(id) {
        const users = await Mysql.find('users', {
            filter: { id },
            view: [
                'id',
                'external_id',
                'name',
                'email',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return users[0] ? mapUserRow(users[0]) : null;
    }

    /**
     * @param {string} externalId
     */
    async getByExternalIdOrNull(externalId) {
        const users = await Mysql.find('users', {
            filter: { external_id: externalId },
            view: [
                'id',
                'external_id',
                'name',
                'email',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return users[0] ? mapUserRow(users[0]) : null;
    }
}

export const usersModel = new UsersModel();

/**
 * @param {{ id: number, external_id: string, name: string | null, email: string | null, credits: number | string, created_at: Date | string, updated_at: Date | string }} row
 */
function mapUserRow(row) {
    return {
        id: Number(row.id),
        externalId: row.external_id,
        name: row.name,
        email: row.email,
        credits: Number(row.credits),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * @param {any} error
 */
function isDuplicateEntryError(error) {
    return error?.code === 'ER_DUP_ENTRY'
        || error?.data?.error?.code === 'ER_DUP_ENTRY';
}