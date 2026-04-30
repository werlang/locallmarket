import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';

/**
 * Order lifecycle business rules: owner scoping, worker-connectivity checks,
 * and atomic dispatch consumption for worker-bound execution jobs.
 */
export class OrdersModel {

    /**
     * @param {{ streamRouter?: import('../helpers/router.js').StreamRouter }} options
     */
    constructor({
        streamRouter: runtimeStreamRouter,
        platformFeePercent = process.env.PLATFORM_FEE_PERCENT
    } = {}) {
        this.streamRouter = runtimeStreamRouter;
        this.platformFeePercent = parsePlatformFeePercent(platformFeePercent);
    }

    /**
     * Creates an order under the requester ownership after validating worker connectivity.
     * New orders are worker-bound execution records and do not enter a public availability pool.
     *
     * @param {string} ownerId
     * @param {{ workerId: string, model: string, price: number, tps: number }} input
     */
    async create(ownerId, input) {
        this.ensureStreamRouter();

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
            is_available: 0,
            is_consumed: 0
        });

        return this.getOrderById(result.insertId);
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
     * Consumes a public order for a user and reserves it for execution.
     * @param {string} consumerId
     * @param {number} orderId
     */
    async consumeForUse(consumerId, orderId) {
        this.ensureStreamRouter();

        const order = await this.getOrderById(orderId);

        if (!order) {
            throw new HttpError(404, 'Order not found.');
        }

        if (order.isConsumed) {
            throw new HttpError(409, 'Order already consumed.');
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

        if (result.status === 'insufficient_credits') {
            throw new HttpError(402, 'Insufficient credits to consume this order.');
        }

        if (result.status !== 'consumed') {
            throw new HttpError(500, 'Unable to consume order at this time.');
        }

        return result;
    }

    /**
     * Finds the first currently dispatchable offer for a requested model.
     * Public offers are represented by order rows marked available and not consumed.
     *
     * @param {string} model
     * @returns {Promise<{ id: number, userId: string, workerId: string, model: string, price: number, tps: number } | null>}
     */
    async findFirstAvailableOfferByModel(model) {
        this.ensureStreamRouter();

        const normalizedModel = typeof model === 'string' ? model.trim() : '';
        if (!normalizedModel) {
            throw new HttpError(400, 'model must be a non-empty string.');
        }

        const candidates = await Mysql.find('orders', {
            filter: {
                model: normalizedModel,
                is_available: 1,
                is_consumed: 0
            },
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
                limit: 100,
                order: { id: 1 }
            }
        });

        for (const candidate of candidates) {
            const order = mapOrderRow(candidate);
            if (!this.streamRouter.isWorkerConnected(order.workerId)) {
                continue;
            }

            if (!this.streamRouter.isWorkerAvailable(order.workerId)) {
                continue;
            }

            // Offer pricing can only be trusted when the offer owner actually owns the connected worker.
            if (!this.streamRouter.isWorkerOwnedBy(order.workerId, order.userId)) {
                continue;
            }

            return order;
        }

        return null;
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
     * Finalizes billing after a worker finishes execution, debiting requester credits,
     * crediting the worker owner, retaining the platform fee, and marking the order complete.
     *
     * @param {{ orderId: number, requesterId: string, workerOwnerId: string, usage?: { total_tokens?: number, totalTokens?: number, prompt_tokens?: number, promptTokens?: number, completion_tokens?: number, completionTokens?: number } }} input
     */
    async settleCompletedOrder({ orderId, requesterId, workerOwnerId, usage }) {
        const settlement = await this.settleCompletedOrderTransaction({
            orderId,
            requesterId,
            workerOwnerId,
            usage
        });

        if (settlement.status === 'order_not_found') {
            throw new HttpError(404, 'Order not found.');
        }

        if (settlement.status === 'order_not_consumed') {
            throw new HttpError(409, 'Order is not currently running.');
        }

        if (settlement.status === 'requester_not_found') {
            throw new HttpError(404, 'Requester user not found.');
        }

        if (settlement.status === 'worker_owner_not_found') {
            throw new HttpError(404, 'Worker owner user not found.');
        }

        if (settlement.status === 'worker_owner_mismatch') {
            throw new HttpError(409, 'Worker ownership mismatch for settlement.');
        }

        if (settlement.status === 'requester_mismatch') {
            throw new HttpError(409, 'Requester mismatch for settlement.');
        }

        if (settlement.status === 'insufficient_credits') {
            throw new HttpError(402, 'Insufficient credits to settle this order.');
        }

        if (settlement.status !== 'settled') {
            throw new HttpError(500, 'Unable to settle order completion at this time.');
        }

        return settlement;
    }

    /**
     * Ensures the stream router dependency is attached before runtime worker checks.
     */
    ensureStreamRouter() {
        if (!this.streamRouter) {
            throw new HttpError(503, 'Worker router is not ready.');
        }
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
                    is_consumed: 0
                },
                { connection }
            );

            if (!consumeResult || consumeResult.affectedRows < 1) {
                return { status: 'already_consumed' };
            }

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
                    is_available: 0,
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

    /**
     * @param {{ orderId: number, requesterId: string, workerOwnerId: string, usage?: { total_tokens?: number, totalTokens?: number, prompt_tokens?: number, promptTokens?: number, completion_tokens?: number, completionTokens?: number } }} input
     */
    async settleCompletedOrderTransaction({ orderId, requesterId, workerOwnerId, usage }) {
        const transactionResult = await Mysql.withTransaction(async (connection) => {
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
            if (!order.isConsumed) {
                return { status: 'order_not_consumed' };
            }

            if (String(order.userId) !== String(requesterId)) {
                return { status: 'requester_mismatch' };
            }

            const requesterRow = await Mysql.findOne('users', {
                filter: { id: requesterId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!requesterRow) {
                return { status: 'requester_not_found' };
            }

            const workerOwnerRow = await Mysql.findOne('users', {
                filter: { id: workerOwnerId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!workerOwnerRow) {
                return { status: 'worker_owner_not_found' };
            }

            const workersOwnerRow = await Mysql.findOne('workers', {
                filter: { id: order.workerId },
                view: ['id', 'user_id'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!workersOwnerRow || workersOwnerRow.user_id !== workerOwnerId) {
                return { status: 'worker_owner_mismatch' };
            }

            const pricePerMillionTokens = Number(order.price);
            const totalTokens = parseUsageTokens(usage);
            const totalCost = roundCredits((pricePerMillionTokens * totalTokens) / 1_000_000);
            const platformFeeAmount = roundCredits(totalCost * (this.platformFeePercent / 100));
            const workerCreditAmount = roundCredits(totalCost - platformFeeAmount);
            const requesterCredits = Number(requesterRow.credits);

            if (requesterCredits < totalCost) {
                return { status: 'insufficient_credits' };
            }

            if (totalCost > 0) {
                await Mysql.update('users', {
                    credits: { dec: totalCost }
                }, requesterRow.id, { connection });
            }

            if (workerCreditAmount > 0) {
                await Mysql.update('users', {
                    credits: { inc: workerCreditAmount }
                }, workerOwnerRow.id, { connection });
            }

            await Mysql.update('orders', {
                price: totalCost,
                is_available: 1,
                is_consumed: 1
            }, {
                id: order.id,
                is_consumed: 1
            }, { connection });

            return {
                status: 'settled',
                orderId: order.id,
                requesterId,
                workerOwnerId,
                usage: {
                    totalTokens
                },
                billing: {
                    pricePerMillionTokens,
                    totalCost,
                    platformFeePercent: this.platformFeePercent,
                    platformFeeAmount,
                    workerCreditAmount
                }
            };
        });

        if (transactionResult.status !== 'settled') {
            return transactionResult;
        }

        const order = await this.getOrderById(transactionResult.orderId);
        const requesterRow = await Mysql.findOne('users', {
            filter: { id: transactionResult.requesterId },
            view: ['id', 'credits'],
            opt: { limit: 1 }
        });
        const workerOwnerRow = await Mysql.findOne('users', {
            filter: { id: transactionResult.workerOwnerId },
            view: ['id', 'credits'],
            opt: { limit: 1 }
        });

        return {
            status: 'settled',
            order,
            requester: requesterRow ? { id: requesterRow.id, credits: Number(requesterRow.credits) } : null,
            workerOwner: workerOwnerRow ? { id: workerOwnerRow.id, credits: Number(workerOwnerRow.credits) } : null,
            usage: transactionResult.usage,
            billing: transactionResult.billing
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
    const isConsumed = Boolean(row.is_consumed);
    const isAvailable = Boolean(row.is_available);
    let status = 'created';
    if (isConsumed && isAvailable) {
        status = 'completed';
    } else if (isConsumed) {
        status = 'running';
    }

    return {
        id: Number(row.id),
        userId: row.user_id,
        workerId: row.worker_id,
        model: row.model,
        price: Number(row.price),
        tps: Number(row.tps),
        isAvailable,
        isConsumed,
        status,
        consumedAt: row.consumed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function parseUsageTokens(usage) {
    if (!usage || typeof usage !== 'object') {
        return 0;
    }

    const totalCandidates = [usage.total_tokens, usage.totalTokens];
    for (const candidate of totalCandidates) {
        const normalized = Number(candidate);
        if (Number.isFinite(normalized) && normalized >= 0) {
            return Math.floor(normalized);
        }
    }

    const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
    const combined = Number.isFinite(prompt) && Number.isFinite(completion)
        ? prompt + completion
        : 0;

    return combined >= 0 ? Math.floor(combined) : 0;
}

function parsePlatformFeePercent(value) {
    const normalized = Number(value);

    if (!Number.isFinite(normalized)) {
        return 0;
    }

    if (normalized < 0) {
        return 0;
    }

    if (normalized > 100) {
        return 100;
    }

    return normalized;
}

function roundCredits(value) {
    return Number(Number(value).toFixed(6));
}
