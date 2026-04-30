import { randomBytes, randomUUID } from 'crypto';
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
        const id = randomUUID();
        const maxApiKeyRetries = 3;

        for (let attempt = 0; attempt < maxApiKeyRetries; attempt += 1) {
            try {
                const apiKey = generateApiKey();
                const record = {
                    id,
                    api_key: apiKey,
                    ...(input.name !== undefined ? { name: input.name } : {}),
                    ...(input.email !== undefined ? { email: input.email } : {})
                };
                await Mysql.insert('users', record);
                const user = await this.getByIdOrNull(id);

                return { user, apiKey };
            } catch (error) {
                if (isDuplicateEntryError(error) && isDuplicateFieldError(error, 'api_key')) {
                    continue;
                }

                if (isDuplicateEntryError(error)) {
                    throw new HttpError(409, 'A user with this identity already exists.');
                }

                throw error;
            }
        }

        throw new HttpError(500, 'Could not generate an API key. Please retry.');
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
     * Resolves a user from a Bearer API key.
     * @param {string} apiKey
     */
    async getByApiKey(apiKey) {
        const user = await this.getByApiKeyOrNull(apiKey);
        if (!user) {
            throw new HttpError(401, 'Invalid API key.');
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
                'max_price',
                'min_tps',
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
     * @param {{ name?: string, email?: string, maxPrice?: number | null, minTps?: number | null }} input
     */
    async updateById(id, input) {
        const user = await this.getById(id);
        const updateData = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.maxPrice !== undefined ? { max_price: input.maxPrice } : {}),
            ...(input.minTps !== undefined ? { min_tps: input.minTps } : {})
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
     * Recreates a user's API key and returns the new secret.
     * @param {string} id
     */
    async resetApiKeyById(id) {
        const user = await this.getById(id);
        const maxApiKeyRetries = 3;

        for (let attempt = 0; attempt < maxApiKeyRetries; attempt += 1) {
            const apiKey = generateApiKey();

            try {
                await Mysql.update('users', { api_key: apiKey }, user.id);
                const refreshed = await this.getByIdOrNull(user.id);
                return { user: refreshed, apiKey };
            } catch (error) {
                if (isDuplicateEntryError(error) && isDuplicateFieldError(error, 'api_key')) {
                    continue;
                }

                throw error;
            }
        }

        throw new HttpError(500, 'Could not reset API key. Please retry.');
    }

    /**
     * @param {string} id
     */
    async getByIdOrNull(id) {
        const user = await Mysql.findOne('users', {
            filter: { id },
            view: [
                'id',
                'name',
                'email',
                'max_price',
                'min_tps',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return user ? mapUserRow(user) : null;
    }

    /**
     * @param {string} apiKey
     */
    async getByApiKeyOrNull(apiKey) {
        const user = await Mysql.findOne('users', {
            filter: { api_key: apiKey },
            view: [
                'id',
                'name',
                'email',
                'max_price',
                'min_tps',
                'credits',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return user ? mapUserRow(user) : null;
    }
}

export const usersModel = new UsersModel();

/**
 * @param {{ id: string, name: string | null, email: string | null, max_price: number | string | null, min_tps: number | string | null, credits: number | string, created_at: Date | string, updated_at: Date | string }} row
 */
function mapUserRow(row) {
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        maxPrice: row.max_price === null ? null : Number(row.max_price),
        minTps: row.min_tps === null ? null : Number(row.min_tps),
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

/**
 * @param {any} error
 * @param {string} field
 */
function isDuplicateFieldError(error, field) {
    const message = error?.message || error?.data?.error?.message || '';
    return typeof message === 'string' && message.includes(field);
}

/**
 * @returns {string}
 */
function generateApiKey() {
    return randomBytes(32).toString('hex');
}