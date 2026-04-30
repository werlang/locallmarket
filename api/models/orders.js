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
     * @param {string} ownerId
     * @param {{ workerId: string, model: string, price: number, tps: number, isAvailable: boolean }} input
     */
    async create(ownerId, input) {
        if (!this.streamRouter.isWorkerConnected(input.workerId)) {
            throw new HttpError(409, 'workerId must reference a currently connected worker.');
        }

        const owner = await this.getOwner(ownerId);
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
     * @param {string} ownerId
     * @param {number} orderId
     */
    async getOwnById(ownerId, orderId) {
        const { order } = await this.getOwnedOrder(ownerId, orderId);
        return order;
    }

    /**
     * Updates an owner-scoped order and validates worker connection when workerId changes.
     * @param {string} ownerId
     * @param {number} orderId
     * @param {{ workerId?: string, model?: string, price?: number, tps?: number, isAvailable?: boolean }} updates
     */
    async updateOwn(ownerId, orderId, updates) {
        const { order } = await this.getOwnedOrder(ownerId, orderId);

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
     * @param {string} ownerId
     * @param {number} orderId
     */
    async deleteOwn(ownerId, orderId) {
        const { order } = await this.getOwnedOrder(ownerId, orderId);
        await Mysql.delete('orders', order.id);
    }

    /**
     * Consumes a public order for a user and debits credits atomically by order price.
     * @param {string} consumerId
     * @param {number} orderId
     */
    async consumeForUse(consumerId, orderId) {
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

        const result = await this.consumeOrderTransaction({ orderId, consumerId });

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
     * @param {string} id
     */
    async getOwner(id) {
        const users = await Mysql.find('users', {
            filter: { id },
            view: ['id'],
            opt: { limit: 1 }
        });
        const owner = users[0]
            ? { id: users[0].id }
            : null;

        if (!owner) {
            throw new HttpError(404, 'Owner user not found.');
        }

        return owner;
    }

    /**
     * Compensating refund: reverses a prior consume and restores credits when dispatch is aborted.
     * A 'not_consumed' outcome is treated as a no-op so the method is idempotent.
     * @param {string} consumerId
     * @param {number} orderId
     */
    async unconsumForUse(consumerId, orderId) {
        const result = await this.unconsumeOrderTransaction({ orderId, consumerId });

        if (result.status === 'order_not_found') {
            throw new HttpError(404, 'Order not found during compensation.');
        }

        if (result.status === 'consumer_not_found') {
            throw new HttpError(404, 'Consumer user not found during compensation.');
        }

        return result;
    }

    /**
     * @param {string} userId
     * @param {number} orderId
     */
    async getOwnedOrder(userId, orderId) {
        const order = await this.getOrderById(orderId);

        if (!order) {
            throw new HttpError(404, 'Order not found.');
        }

        if (order.userId !== userId) {
            throw new HttpError(403, 'You can only mutate your own orders.');
        }

        return { owner: { id: userId }, order };
    }

    /**
     * @param {number} orderId
     */
    async getOrderById(orderId) {
        const order = await Mysql.findOne('orders', {
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

        return order ? mapOrderRow(order) : null;
    }

    /**
     * @param {{ orderId: number, consumerId: string }} input
     */
    async consumeOrderTransaction({ orderId, consumerId }) {
        const transactionResult = await Mysql.withTransaction(async (connection) => {
            const consumerRow = await Mysql.findOne('users', {
                filter: { id: consumerId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!consumerRow) {
                return { status: 'consumer_not_found' };
            }

            const orderRow = await Mysql.findOne('orders', {
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
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!orderRow) {
                return { status: 'order_not_found' };
            }

            const order = mapOrderRow(orderRow);
            const consumer = {
                id: consumerRow.id,
                credits: Number(consumerRow.credits)
            };

            if (order.isConsumed) {
                return { status: 'already_consumed' };
            }

            if (!order.isAvailable) {
                return { status: 'order_unavailable' };
            }

            if (consumer.credits < order.price) {
                return { status: 'insufficient_credits' };
            }

            const consumeResult = await Mysql.update(
                'orders',
                {
                    is_consumed: 1,
                    is_available: 0,
                    consumed_at: Mysql.raw('NOW()')
                },
                {
                    id: order.id,
                    is_consumed: 0,
                    is_available: 1
                },
                { connection }
            );

            if (!consumeResult || consumeResult.affectedRows < 1) {
                return { status: 'already_consumed' };
            }

            await Mysql.update('users', {
                credits: { dec: order.price }
            }, consumer.id, { connection });

            return {
                status: 'consumed',
                orderId: order.id,
                consumerId: consumer.id
            };
        });

        if (transactionResult.status !== 'consumed') {
            return transactionResult;
        }

        const consumedOrder = await this.getOrderById(transactionResult.orderId);
        const updatedConsumerRow = await Mysql.findOne('users', {
            filter: { id: transactionResult.consumerId },
            view: ['id', 'credits'],
            opt: { limit: 1 }
        });
        const updatedConsumer = {
            id: updatedConsumerRow.id,
            credits: Number(updatedConsumerRow.credits)
        };

        return {
            status: 'consumed',
            order: consumedOrder,
            consumer: updatedConsumer
        };
    }

    /**
     * @param {{ orderId: number, consumerId: string }} input
     */
    async unconsumeOrderTransaction({ orderId, consumerId }) {
        const transactionResult = await Mysql.withTransaction(async (connection) => {
            const consumerRow = await Mysql.findOne('users', {
                filter: { id: consumerId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!consumerRow) {
                return { status: 'consumer_not_found' };
            }

            const orderRow = await Mysql.findOne('orders', {
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
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!orderRow) {
                return { status: 'order_not_found' };
            }

            const order = mapOrderRow(orderRow);
            const consumer = {
                id: consumerRow.id,
                credits: Number(consumerRow.credits)
            };

            if (!order.isConsumed) {
                return { status: 'not_consumed' };
            }

            const restoreResult = await Mysql.update(
                'orders',
                {
                    is_consumed: 0,
                    is_available: 1,
                    consumed_at: null
                },
                {
                    id: order.id,
                    is_consumed: 1
                },
                { connection }
            );

            if (!restoreResult || restoreResult.affectedRows < 1) {
                return { status: 'not_consumed' };
            }

            await Mysql.update('users', {
                credits: { inc: order.price }
            }, consumer.id, { connection });

            return {
                status: 'restored',
                orderId: order.id,
                consumerId: consumer.id
            };
        });

        if (transactionResult.status !== 'restored') {
            return transactionResult;
        }

        const restoredOrder = await this.getOrderById(transactionResult.orderId);
        const updatedConsumerRow = await Mysql.findOne('users', {
            filter: { id: transactionResult.consumerId },
            view: ['id', 'credits'],
            opt: { limit: 1 }
        });
        const updatedConsumer = {
            id: updatedConsumerRow.id,
            credits: Number(updatedConsumerRow.credits)
        };

        return {
            status: 'restored',
            order: restoredOrder,
            consumer: updatedConsumer
        };
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
        userId: row.user_id,
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
