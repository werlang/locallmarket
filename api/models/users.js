import { randomUUID } from 'crypto';
import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';

/**
 * Applies user business rules on top of persistence drivers.
 */
export class UsersModel {
    /**
     * Registers a new API user with an auto-generated UUID primary key.
     * @param {{ name?: string, email?: string }} input
     */
    async register(input) {
        try {
            const id = randomUUID();
            const record = {
                id,
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.email !== undefined ? { email: input.email } : {})
            };
            await Mysql.insert('users', record);
            return this.getByIdOrNull(id);
        } catch (error) {
            if (isDuplicateEntryError(error)) {
                throw new HttpError(409, 'A user with this identity already exists.');
            }

            throw error;
        }
    }

    /**
     * Gets a user profile by id, throwing 404 if not found.
     * @param {string} id
     */
    async getById(id) {
        const user = await this.getByIdOrNull(id);
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
     * @param {string} id
     * @param {{ name?: string, email?: string }} input
     */
    async updateById(id, input) {
        const user = await this.getById(id);
        const updateData = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {})
        };

        try {
            await Mysql.update('users', updateData, user.id);
            return this.getByIdOrNull(user.id);
        } catch (error) {
            if (isDuplicateEntryError(error)) {
                throw new HttpError(409, 'Email already in use by another user.');
            }

            throw error;
        }
    }

    /**
     * Adds credits to an existing user account.
     * @param {string} id
     * @param {number} amount
     */
    async rechargeById(id, amount) {
        if (amount <= 0) {
            throw new HttpError(400, 'Recharge amount must be positive.');
        }
        const user = await this.getById(id);
        await Mysql.update('users', { credits: { inc: amount } }, user.id);
        return this.getByIdOrNull(user.id);
    }

    /**
     * Deletes an existing user account.
     * @param {string} id
     */
    async deleteById(id) {
        const user = await this.getById(id);
        await Mysql.delete('users', user.id);
    }

    /**
     * @param {string} id
     */
    async getByIdOrNullOrNull(id) {
        const users = await Mysql.findOne('users', {
            filter: { id },
            view: [
                'id',
                'name',
                'email',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return users ? mapUserRow(users) : null;
    }
}

export const usersModel = new UsersModel();

/**
 * @param {{ id: string, name: string | null, email: string | null, credits: number | string, created_at: Date | string, updated_at: Date | string }} row
 */
function mapUserRow(row) {
    return {
        id: row.id,
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