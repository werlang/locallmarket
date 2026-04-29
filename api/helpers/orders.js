import { HttpError } from './error.js';
import { HttpStream } from './stream.js';

/**
 * Validates and normalizes owner identity received in request headers.
 * @param {Record<string, unknown>} headers
 * @returns {string}
 */
export function parseOwnerExternalIdHeader(headers) {
    const raw = headers?.['x-user-external-id'];

    if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new HttpError(401, 'x-user-external-id header is required.');
    }

    return raw.trim();
}

/**
 * Validates payload for order creation.
 * @param {any} body
 * @returns {{ workerId: string, model: string, price: number, tps: number, isAvailable: boolean }}
 */
export function parseCreateOrderBody(body) {
    const payload = body || {};

    return {
        workerId: parseRequiredString(payload.workerId, 'workerId'),
        model: parseRequiredString(payload.model, 'model'),
        price: parsePositiveNumber(payload.price, 'price'),
        tps: parsePositiveInteger(payload.tps, 'tps'),
        isAvailable: parseOptionalBoolean(payload.isAvailable, true)
    };
}

/**
 * Validates payload for order updates.
 * @param {any} body
 * @returns {{ workerId?: string, model?: string, price?: number, tps?: number, isAvailable?: boolean }}
 */
export function parseUpdateOrderBody(body) {
    const payload = body || {};
    const result = {};

    if (Object.hasOwn(payload, 'workerId')) {
        result.workerId = parseRequiredString(payload.workerId, 'workerId');
    }

    if (Object.hasOwn(payload, 'model')) {
        result.model = parseRequiredString(payload.model, 'model');
    }

    if (Object.hasOwn(payload, 'price')) {
        result.price = parsePositiveNumber(payload.price, 'price');
    }

    if (Object.hasOwn(payload, 'tps')) {
        result.tps = parsePositiveInteger(payload.tps, 'tps');
    }

    if (Object.hasOwn(payload, 'isAvailable')) {
        result.isAvailable = parseOptionalBoolean(payload.isAvailable, true);
    }

    if (Object.keys(result).length === 0) {
        throw new HttpError(400, 'At least one field must be provided: workerId, model, price, tps, isAvailable.');
    }

    return result;
}

/**
 * Validates and normalizes path param id.
 * @param {unknown} value
 * @returns {number}
 */
export function parseOrderId(value) {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HttpError(400, 'orderId must be a positive integer.');
    }

    return parsed;
}

/**
 * Validates and normalizes the worker-use streaming payload.
 * @param {any} body
 * @returns {{ message: string }}
 */
export function parseUseWorkerBody(body) {
    const payload = body || {};
    const message = typeof payload.message === 'string' && payload.message.trim().length > 0
        ? payload.message.trim()
        : (typeof payload.input === 'string' && payload.input.trim().length > 0
            ? payload.input.trim()
            : null);

    if (!message) {
        throw new HttpError(400, 'message must be a non-empty string.');
    }

    return { message };
}

/**
 * Validates legacy /stream payload that routes by model instead of order consume.
 * @param {any} body
 * @returns {{ message: string, model: string }}
 */
export function parseLegacyStreamBody(body) {
    const payload = body || {};
    const { message } = parseUseWorkerBody(payload);

    if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
        throw new HttpError(400, 'model is required in the request body.');
    }

    return {
        message,
        model: payload.model.trim()
    };
}

/**
 * Validates listing filters for public orderbook endpoints.
 * @param {any} query
 * @returns {{ model?: string, minPrice?: number, maxPrice?: number, minTps?: number, maxTps?: number, onlyAvailable: boolean, limit: number, offset: number }}
 */
export function parseListOrdersQuery(query) {
    const payload = query || {};
    const model = parseOptionalString(payload.model, 'model');
    const minPrice = parseOptionalPositiveNumber(payload.minPrice, 'minPrice');
    const maxPrice = parseOptionalPositiveNumber(payload.maxPrice, 'maxPrice');
    const minTps = parseOptionalPositiveInteger(payload.minTps, 'minTps');
    const maxTps = parseOptionalPositiveInteger(payload.maxTps, 'maxTps');
    const onlyAvailable = parseOptionalBoolean(payload.onlyAvailable, false);
    const limit = parseOptionalPositiveInteger(payload.limit, 'limit', 100);
    const offset = parseOptionalNonNegativeInteger(payload.offset, 'offset', 0);

    if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
        throw new HttpError(400, 'minPrice cannot be greater than maxPrice.');
    }

    if (minTps != null && maxTps != null && minTps > maxTps) {
        throw new HttpError(400, 'minTps cannot be greater than maxTps.');
    }

    return {
        ...(model ? { model } : {}),
        ...(minPrice != null ? { minPrice } : {}),
        ...(maxPrice != null ? { maxPrice } : {}),
        ...(minTps != null ? { minTps } : {}),
        ...(maxTps != null ? { maxTps } : {}),
        onlyAvailable,
        limit,
        offset
    };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function parseRequiredString(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(400, `${field} must be a non-empty string.`);
    }

    return value.trim();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function parseOptionalString(value, field) {
    if (value === undefined) {
        return undefined;
    }

    return parseRequiredString(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function parsePositiveNumber(value, field) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HttpError(400, `${field} must be a positive number.`);
    }

    return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 */
function parseOptionalPositiveNumber(value, field) {
    if (value === undefined) {
        return undefined;
    }

    return parsePositiveNumber(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function parsePositiveInteger(value, field) {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HttpError(400, `${field} must be a positive integer.`);
    }

    return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalPositiveInteger(value, field, fallback) {
    if (value === undefined) {
        return fallback;
    }

    return parsePositiveInteger(value, field);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalNonNegativeInteger(value, field, fallback) {
    if (value === undefined) {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new HttpError(400, `${field} must be a non-negative integer.`);
    }

    return parsed;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseOptionalBoolean(value, fallback) {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();

        if (normalized === 'true' || normalized === '1') {
            return true;
        }

        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }

    throw new HttpError(400, 'Boolean fields must be true/false.');
}

/**
 * Shared order-consume streaming flow for worker-use and legacy stream routes.
 * Consumes the order atomically (debit credits), opens an SSE stream, and enqueues a
 * targeted dispatch job to the order's worker. If the worker disconnects while the job is
 * still queued (never dispatched), the consume is reversed via a compensating refund.
 *
 * @param {{
 *   req: import('express').Request,
 *   res: import('express').Response,
 *   next: import('express').NextFunction,
 *   orderIdRaw: unknown,
 *   ordersModel: import('../models/orders.js').OrdersModel,
 *   streamRouter: import('./router.js').StreamRouter
 * }} options
 */
export async function applyOrderUseStream({ req, res, next, orderIdRaw, ordersModel, streamRouter }) {
    let stream;

    try {
        const consumerExternalId = parseOwnerExternalIdHeader(req.headers);
        const orderId = parseOrderId(orderIdRaw);
        const streamBody = parseUseWorkerBody(req.body);
        const consumed = await ordersModel.consumeForUse(consumerExternalId, orderId);

        stream = new HttpStream(res);
        const jobId = streamRouter.enqueue({
            payload: {
                message: streamBody.message,
                model: consumed.order.model
            },
            stream,
            targetWorkerId: consumed.order.workerId,
            onJobAborted: async () => {
                console.error(`[applyOrderUseStream] Queued job aborted for order ${orderId}. Compensating consume...`);
                try {
                    await ordersModel.unconsumForUse(consumerExternalId, orderId);
                } catch (refundError) {
                    console.error('[applyOrderUseStream] Compensation refund failed:', refundError);
                }

                if (!stream.closed) {
                    stream.event('error').send(JSON.stringify({ error: 'Worker disconnected before processing. Order has been refunded.' }));
                    stream.close();
                }
            }
        });

        res.once('close', () => {
            streamRouter.cancel(jobId);
        });
    } catch (error) {
        if (res.headersSent) {
            stream?.event('error').send(JSON.stringify({ error: error?.message || 'Invalid request.' }));
            stream?.close();
            return;
        }

        next(error);
    }
}

/**
 * Legacy /stream compatibility flow.
 * Keeps the pre-orderbook behavior by enqueuing untargeted model-based jobs.
 * @param {{
 *   req: import('express').Request,
 *   res: import('express').Response,
 *   next: import('express').NextFunction,
 *   streamRouter: import('./router.js').StreamRouter
 * }} options
 */
export async function applyLegacyStream({ req, res, next, streamRouter }) {
    let stream;

    try {
        const payload = parseLegacyStreamBody(req.body);
        stream = new HttpStream(res);

        const jobId = streamRouter.enqueue({ payload, stream });

        res.once('close', () => {
            streamRouter.cancel(jobId);
        });
    } catch (error) {
        if (res.headersSent) {
            stream?.event('error').send(JSON.stringify({ error: error?.message || 'Invalid request.' }));
            stream?.close();
            return;
        }

        next(error);
    }
}
