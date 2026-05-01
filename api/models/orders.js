import { HttpError } from '../helpers/error.js';
import { Mysql } from '../helpers/mysql.js';

/**
 * Execution receipt lifecycle: creation on dispatch, settlement on completion, failure on error.
 * Orders are immutable records created by the completions endpoint — not marketplace offers.
 */
export class OrdersModel {

    /**
     * @param {{ platformFeePercent?: string | number }} [options]
     */
    constructor({ platformFeePercent = process.env.PLATFORM_FEE_PERCENT } = {}) {
        this.platformFeePercent = parsePlatformFeePercent(platformFeePercent);
    }

    /**
     * Creates an execution receipt in 'running' status when a job is dispatched to a worker.
     *
     * @param {string} requesterId
     * @param {{ workerId: string, model: string, price: number }} input
     * @returns {Promise<object>}
     */
    async createReceipt(requesterId, { workerId, model, price }) {
        if (!requesterId) throw new HttpError(400, 'requesterId is required.');

        const [result] = await Mysql.insert('orders', {
            requester_id: requesterId,
            worker_id: workerId,
            model,
            price,
            status: 'running',
            started_at: Mysql.raw('NOW()')
        });

        return this.getOrderById(result.insertId);
    }

    /**
     * Lists execution receipts owned by the requester (most recent first).
     * @param {string} requesterId
     */
    async listOwn(requesterId) {
        if (!requesterId) throw new HttpError(400, 'requesterId is required.');

        const rows = await Mysql.find('orders', {
            filter: { requester_id: requesterId },
            view: ['id', 'requester_id', 'worker_id', 'model', 'price', 'tps', 'status', 'started_at', 'completed_at', 'created_at', 'updated_at'],
            opt: { order: { created_at: -1 } }
        });

        return rows.map(mapOrderRow);
    }

    /**
     * Finalizes billing after a worker finishes execution successfully.
     * Debits the requester, credits the worker owner (minus platform fee), and marks the order complete.
     *
     * @param {{ orderId: number, requesterId: string, workerOwnerId: string, usage?: object, startedAtMs?: number }} input
     */
    async completeReceipt({ orderId, requesterId, workerOwnerId, usage, startedAtMs }) {
        const completedAtMs = Date.now();
        const observedTps = computeObservedTps({ usage, startedAtMs, completedAtMs });

        const settlement = await this.#completeReceiptTransaction({
            orderId,
            requesterId,
            workerOwnerId,
            usage,
            tps: observedTps
        });

        if (settlement.status === 'order_not_found') throw new HttpError(404, 'Order not found.');
        if (settlement.status === 'order_not_running') throw new HttpError(409, 'Order is not currently running.');
        if (settlement.status === 'requester_mismatch') throw new HttpError(409, 'Requester mismatch for settlement.');
        if (settlement.status === 'worker_owner_mismatch') throw new HttpError(409, 'Worker ownership mismatch for settlement.');
        if (settlement.status === 'requester_not_found') throw new HttpError(404, 'Requester user not found.');
        if (settlement.status === 'worker_owner_not_found') throw new HttpError(404, 'Worker owner user not found.');
        if (settlement.status === 'insufficient_credits') throw new HttpError(402, 'Insufficient credits to settle this order.');
        if (settlement.status !== 'settled') throw new HttpError(500, 'Unable to settle order at this time.');

        return settlement;
    }

    /**
     * Marks an execution receipt as failed (e.g. worker error or disconnect).
     * @param {number} orderId
     */
    async failReceipt(orderId) {
        await Mysql.update('orders', {
            status: 'failed',
            completed_at: Mysql.raw('NOW()')
        }, { id: orderId, status: 'running' });
    }

    /**
     * @param {number} orderId
     */
    async getOrderById(orderId) {
        const row = await Mysql.findOne('orders', {
            filter: { id: orderId },
            view: ['id', 'requester_id', 'worker_id', 'model', 'price', 'tps', 'status', 'started_at', 'completed_at', 'created_at', 'updated_at'],
            opt: { limit: 1 }
        });
        return row ? mapOrderRow(row) : null;
    }

    /**
     * @param {{ orderId: number, requesterId: string, workerOwnerId: string, usage?: object, tps?: number | null }} input
     */
    async #completeReceiptTransaction({ orderId, requesterId, workerOwnerId, usage, tps }) {
        const transactionResult = await Mysql.withTransaction(async (connection) => {
            const orderRow = await Mysql.findOne('orders', {
                filter: { id: orderId },
                view: ['id', 'requester_id', 'worker_id', 'model', 'price', 'tps', 'status', 'started_at', 'completed_at', 'created_at', 'updated_at'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!orderRow) return { status: 'order_not_found' };

            const order = mapOrderRow(orderRow);
            if (order.status !== 'running') return { status: 'order_not_running' };
            if (String(order.requesterId) !== String(requesterId)) return { status: 'requester_mismatch' };

            // Verify worker is still owned by the expected owner
            const workerRow = await Mysql.findOne('workers', {
                filter: { id: order.workerId },
                view: ['id', 'user_id'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!workerRow || String(workerRow.user_id) !== String(workerOwnerId))
                return { status: 'worker_owner_mismatch' };

            const requesterRow = await Mysql.findOne('users', {
                filter: { id: requesterId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!requesterRow) return { status: 'requester_not_found' };

            const workerOwnerRow = await Mysql.findOne('users', {
                filter: { id: workerOwnerId },
                view: ['id', 'credits'],
                opt: { limit: 1, forUpdate: true }
            }, { connection });

            if (!workerOwnerRow) return { status: 'worker_owner_not_found' };

            const pricePerMillionTokens = Number(order.price);
            const totalTokens = parseUsageTokens(usage);
            const totalCost = roundCredits((pricePerMillionTokens * totalTokens) / 1_000_000);
            const platformFeeAmount = roundCredits(totalCost * (this.platformFeePercent / 100));
            const workerCreditAmount = roundCredits(totalCost - platformFeeAmount);
            const requesterCredits = Number(requesterRow.credits);

            if (requesterCredits < totalCost) return { status: 'insufficient_credits' };

            if (totalCost > 0) {
                await Mysql.update('users', { credits: { dec: totalCost } }, requesterRow.id, { connection });
            }

            if (workerCreditAmount > 0) {
                await Mysql.update('users', { credits: { inc: workerCreditAmount } }, workerOwnerRow.id, { connection });
            }

            await Mysql.update('orders', {
                price: totalCost,
                tps: tps ?? null,
                status: 'completed',
                completed_at: Mysql.raw('NOW()')
            }, { id: order.id, status: 'running' }, { connection });

            return {
                status: 'settled',
                orderId: order.id,
                requesterId,
                workerOwnerId,
                usage: { totalTokens },
                billing: {
                    pricePerMillionTokens,
                    totalCost,
                    platformFeePercent: this.platformFeePercent,
                    platformFeeAmount,
                    workerCreditAmount
                }
            };
        });

        if (transactionResult.status !== 'settled') return transactionResult;

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

function mapOrderRow(row) {
    return {
        id: Number(row.id),
        requesterId: row.requester_id,
        workerId: row.worker_id,
        model: row.model,
        price: Number(row.price),
        tps: row.tps != null ? Number(row.tps) : null,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function parseUsageTokens(usage) {
    if (!usage || typeof usage !== 'object') return 0;

    for (const key of ['total_tokens', 'totalTokens']) {
        const n = Number(usage[key]);
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }

    const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
    const combined = Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : 0;
    return combined >= 0 ? Math.floor(combined) : 0;
}

function parsePlatformFeePercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
}

function roundCredits(value) {
    return Number(Number(value).toFixed(6));
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
