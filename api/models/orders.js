import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';

/**
 * Orderbook business rules: owner scoping, worker-connectivity checks, and public filtering.
 */
export class OrdersModel {

    /**
     * @param {{ streamRouter?: import('../helpers/router.js').StreamRouter }} options
     */
    constructor({ streamRouter: runtimeStreamRouter } = {}) {
        this.streamRouter = runtimeStreamRouter;
    }

    /**
     * Creates an order under the requester ownership after validating worker connectivity.
     * @param {string} ownerExternalId
     * @param {{ workerId: string, model: string, price: number, tps: number, isAvailable: boolean }} input
     */
    async create(ownerExternalId, input) {
        if (!this.streamRouter.isWorkerConnected(input.workerId)) {
            throw new HttpError(409, 'workerId must reference a currently connected worker.');
        }

        const owner = await this.getOwner(ownerExternalId);
        const [result] = await Mysql.insert('orders', {
            user_id: owner.id,
            worker_id: input.workerId,
            model: input.model,
            price: input.price,
            tps: input.tps,
            is_available: input.isAvailable ? 1 : 0,
            is_consumed: 0
        });

        return this.getOrderById(result.insertId);
    }

    /**
     * Returns a single owner-scoped order.
     * @param {string} ownerExternalId
     * @param {number} orderId
     */
    async getOwnById(ownerExternalId, orderId) {
        const { order } = await this.getOwnedOrder(ownerExternalId, orderId);
        return order;
    }

    /**
     * Updates an owner-scoped order and validates worker connection when workerId changes.
     * @param {string} ownerExternalId
     * @param {number} orderId
     * @param {{ workerId?: string, model?: string, price?: number, tps?: number, isAvailable?: boolean }} updates
     */
    async updateOwn(ownerExternalId, orderId, updates) {
        const { order } = await this.getOwnedOrder(ownerExternalId, orderId);

        if (updates.workerId && !this.streamRouter.isWorkerConnected(updates.workerId)) {
            throw new HttpError(409, 'workerId must reference a currently connected worker.');
        }

        const updateData = {
            ...(updates.workerId !== undefined ? { worker_id: updates.workerId } : {}),
            ...(updates.model !== undefined ? { model: updates.model } : {}),
            ...(updates.price !== undefined ? { price: updates.price } : {}),
            ...(updates.tps !== undefined ? { tps: updates.tps } : {}),
            ...(updates.isAvailable !== undefined ? { is_available: updates.isAvailable ? 1 : 0 } : {})
        };

        const result = await Mysql.update('orders', updateData, order.id);
        if (!result || result.affectedRows < 1) {
            throw new HttpError(404, 'Order not found.');
        }

        return this.getOrderById(order.id);
    }

    /**
     * Deletes an owner-scoped order.
     * @param {string} ownerExternalId
     * @param {number} orderId
     */
    async deleteOwn(ownerExternalId, orderId) {
        const { order } = await this.getOwnedOrder(ownerExternalId, orderId);
        await Mysql.delete('orders', order.id);
    }

    /**
     * Consumes a public order for a user and debits credits atomically by order price.
     * @param {string} consumerExternalId
     * @param {number} orderId
     */
    async consumeForUse(consumerExternalId, orderId) {
        const order = await this.getOrderById(orderId);

        if (!order) {
            throw new HttpError(404, 'Order not found.');
        }

        if (order.isConsumed) {
            throw new HttpError(409, 'Order already consumed.');
        }

        if (!order.isAvailable) {
            throw new HttpError(409, 'Order is not available for consumption.');
        }

        if (!this.streamRouter.isWorkerConnected(order.workerId)) {
            throw new HttpError(409, 'Order worker is not connected.');
        }

        if (!this.streamRouter.isWorkerAvailable(order.workerId)) {
            throw new HttpError(409, 'Order worker is busy and cannot be consumed right now.');
        }

        const result = await this.consumeOrderTransaction({ orderId, consumerExternalId });

        if (result.status === 'consumer_not_found') {
            throw new HttpError(404, 'Consumer user not found.');
        }

        if (result.status === 'order_not_found') {
            throw new HttpError(404, 'Order not found.');
        }

        if (result.status === 'already_consumed') {
            throw new HttpError(409, 'Order already consumed.');
        }

        if (result.status === 'order_unavailable') {
            throw new HttpError(409, 'Order is not available for consumption.');
        }

        if (result.status === 'insufficient_credits') {
            throw new HttpError(402, 'Insufficient credits to consume this order.');
        }

        if (result.status !== 'consumed') {
            throw new HttpError(500, 'Unable to consume order at this time.');
        }

        return result;
    }

    /**
     * Lists public orders with optional filters and real-time availability overlay.
     * @param {{ model?: string, minPrice?: number, maxPrice?: number, minTps?: number, maxTps?: number, onlyAvailable: boolean, limit: number, offset: number }} filters
     */
    async listPublic(filters) {
        const filter = {
            is_consumed: 0
        };

        if (filters.model) {
            filter.model = filters.model;
        }

        if (filters.minPrice !== undefined && filters.maxPrice !== undefined) {
            filter.price = Mysql.between(filters.minPrice, filters.maxPrice);
        } else if (filters.minPrice !== undefined) {
            filter.price = Mysql.gte(filters.minPrice);
        } else if (filters.maxPrice !== undefined) {
            filter.price = Mysql.lte(filters.maxPrice);
        }

        if (filters.minTps !== undefined && filters.maxTps !== undefined) {
            filter.tps = Mysql.between(filters.minTps, filters.maxTps);
        } else if (filters.minTps !== undefined) {
            filter.tps = Mysql.gte(filters.minTps);
        } else if (filters.maxTps !== undefined) {
            filter.tps = Mysql.lte(filters.maxTps);
        }

        const rows = await Mysql.find('orders', {
            filter,
            view: [
                'id',
                'user_id',
                'worker_id',
                'model',
                'price',
                'tps',
                'is_available',
                'is_consumed',
                'consumed_at',
                'created_at',
                'updated_at'
            ],
            opt: {
                limit: filters.limit,
                skip: filters.offset,
                order: { id: -1 }
            }
        });

        const hydrated = rows.map((orderRow) => {
            const order = mapOrderRow(orderRow);
            const connected = this.streamRouter.isWorkerConnected(order.workerId);
            const currentlyAvailable = Boolean(order.isAvailable) && connected && this.streamRouter.isWorkerAvailable(order.workerId);

            return {
                ...order,
                isAvailable: currentlyAvailable,
                workerConnected: connected
            };
        });

        if (filters.onlyAvailable) {
            return hydrated.filter((order) => order.isAvailable);
        }

        return hydrated;
    }

    /**
     * @param {string} ownerExternalId
     */
    async getOwner(ownerExternalId) {
        const users = await Mysql.find('users', {
            filter: { external_id: ownerExternalId },
            view: ['id', 'external_id'],
            opt: { limit: 1 }
        });
        const owner = users[0]
            ? { id: Number(users[0].id), externalId: users[0].external_id }
            : null;

        if (!owner) {
            throw new HttpError(404, 'Owner user not found.');
        }

        return owner;
    }

    /**
     * Compensating refund: reverses a prior consume and restores credits when dispatch is aborted.
     * A 'not_consumed' outcome is treated as a no-op so the method is idempotent.
     * @param {string} consumerExternalId
     * @param {number} orderId
     */
    async unconsumForUse(consumerExternalId, orderId) {
        const result = await this.unconsumeOrderTransaction({ orderId, consumerExternalId });

        if (result.status === 'order_not_found') {
            throw new HttpError(404, 'Order not found during compensation.');
        }

        if (result.status === 'consumer_not_found') {
            throw new HttpError(404, 'Consumer user not found during compensation.');
        }

        return result;
    }

    /**
     * @param {string} ownerExternalId
     * @param {number} orderId
     */
    async getOwnedOrder(ownerExternalId, orderId) {
        const owner = await this.getOwner(ownerExternalId);
        const order = await this.getOrderById(orderId);

        if (!order) {
            throw new HttpError(404, 'Order not found.');
        }

        if (Number(order.userId) !== Number(owner.id)) {
            throw new HttpError(403, 'You can only mutate your own orders.');
        }

        return { owner, order };
    }

    /**
     * @param {number} orderId
     */
    async getOrderById(orderId) {
        const orders = await Mysql.find('orders', {
            filter: { id: orderId },
            view: [
                'id',
                'user_id',
                'worker_id',
                'model',
                'price',
                'tps',
                'is_available',
                'is_consumed',
                'consumed_at',
                'created_at',
                'updated_at'
            ],
            opt: { limit: 1 }
        });

        return orders[0] ? mapOrderRow(orders[0]) : null;
    }

    /**
     * @param {{ orderId: number, consumerExternalId: string }} input
     */
    async consumeOrderTransaction({ orderId, consumerExternalId }) {
        await Mysql.connect();
        const connection = await Mysql.connection.getConnection();

        try {
            await connection.beginTransaction();

            const [consumerRows] = await connection.execute(
                'SELECT id, external_id, credits FROM users WHERE external_id = ? FOR UPDATE',
                [consumerExternalId]
            );

            if (!consumerRows[0]) {
                await connection.rollback();
                return { status: 'consumer_not_found' };
            }

            const [orderRows] = await connection.execute(
                'SELECT id, user_id, worker_id, model, price, tps, is_available, is_consumed, consumed_at, created_at, updated_at FROM orders WHERE id = ? FOR UPDATE',
                [orderId]
            );

            if (!orderRows[0]) {
                await connection.rollback();
                return { status: 'order_not_found' };
            }

            const order = mapOrderRow(orderRows[0]);
            const consumer = {
                id: Number(consumerRows[0].id),
                externalId: consumerRows[0].external_id,
                credits: Number(consumerRows[0].credits)
            };

            if (order.isConsumed) {
                await connection.rollback();
                return { status: 'already_consumed' };
            }

            if (!order.isAvailable) {
                await connection.rollback();
                return { status: 'order_unavailable' };
            }

            if (consumer.credits < order.price) {
                await connection.rollback();
                return { status: 'insufficient_credits' };
            }

            await connection.execute(
                'UPDATE users SET credits = credits - ? WHERE id = ?',
                [order.price, consumer.id]
            );

            const [consumeResult] = await connection.execute(
                'UPDATE orders SET is_consumed = 1, is_available = 0, consumed_at = NOW() WHERE id = ? AND is_consumed = 0 AND is_available = 1',
                [order.id]
            );

            if (!consumeResult || consumeResult.affectedRows < 1) {
                await connection.rollback();
                return { status: 'already_consumed' };
            }

            await connection.commit();

            const consumedOrder = await this.getOrderById(order.id);
            const [updatedConsumerRows] = await Mysql.connection.execute(
                'SELECT id, external_id, credits FROM users WHERE id = ?',
                [consumer.id]
            );
            const updatedConsumer = {
                id: Number(updatedConsumerRows[0].id),
                externalId: updatedConsumerRows[0].external_id,
                credits: Number(updatedConsumerRows[0].credits)
            };

            return {
                status: 'consumed',
                order: consumedOrder,
                consumer: updatedConsumer
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    /**
     * @param {{ orderId: number, consumerExternalId: string }} input
     */
    async unconsumeOrderTransaction({ orderId, consumerExternalId }) {
        await Mysql.connect();
        const connection = await Mysql.connection.getConnection();

        try {
            await connection.beginTransaction();

            const [consumerRows] = await connection.execute(
                'SELECT id, external_id, credits FROM users WHERE external_id = ? FOR UPDATE',
                [consumerExternalId]
            );
            if (!consumerRows[0]) {
                await connection.rollback();
                return { status: 'consumer_not_found' };
            }

            const [orderRows] = await connection.execute(
                'SELECT id, user_id, worker_id, model, price, tps, is_available, is_consumed, consumed_at, created_at, updated_at FROM orders WHERE id = ? FOR UPDATE',
                [orderId]
            );
            if (!orderRows[0]) {
                await connection.rollback();
                return { status: 'order_not_found' };
            }

            const order = mapOrderRow(orderRows[0]);
            const consumer = {
                id: Number(consumerRows[0].id),
                externalId: consumerRows[0].external_id,
                credits: Number(consumerRows[0].credits)
            };

            if (!order.isConsumed) {
                await connection.rollback();
                return { status: 'not_consumed' };
            }

            await connection.execute('UPDATE users SET credits = credits + ? WHERE id = ?', [order.price, consumer.id]);
            await connection.execute(
                'UPDATE orders SET is_consumed = 0, is_available = 1, consumed_at = NULL WHERE id = ? AND is_consumed = 1',
                [order.id]
            );

            await connection.commit();

            const restoredOrder = await this.getOrderById(order.id);
            const [updatedConsumerRows] = await Mysql.connection.execute(
                'SELECT id, external_id, credits FROM users WHERE id = ?',
                [consumer.id]
            );
            const updatedConsumer = {
                id: Number(updatedConsumerRows[0].id),
                externalId: updatedConsumerRows[0].external_id,
                credits: Number(updatedConsumerRows[0].credits)
            };

            return {
                status: 'restored',
                order: restoredOrder,
                consumer: updatedConsumer
            };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

export const ordersModel = new OrdersModel();

/**
 * @param {{
 *  id: number,
 *  user_id: number,
 *  worker_id: string,
 *  model: string,
 *  price: number | string,
 *  tps: number,
 *  is_available: number | boolean,
 *  is_consumed: number | boolean,
 *  consumed_at: Date | string | null,
 *  created_at: Date | string,
 *  updated_at: Date | string
 * }} row
 */
function mapOrderRow(row) {
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        workerId: row.worker_id,
        model: row.model,
        price: Number(row.price),
        tps: Number(row.tps),
        isAvailable: Boolean(row.is_available),
        isConsumed: Boolean(row.is_consumed),
        consumedAt: row.consumed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
