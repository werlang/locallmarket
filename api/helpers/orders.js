import { HttpError } from './error.js';

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
 * Validates legacy /tasks/run payload that routes by model instead of order consume.
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
 * Validates and normalizes payload to create a worker-bound offer order.
 * @param {any} body
 * @returns {{ userId?: string, workerId: string, model: string, price: number, tps: number, enabled?: boolean }}
 */
export function parseCreateWorkerOrderBody(body) {
    const payload = body || {};

    return {
        ...(Object.hasOwn(payload, 'userId') ? { userId: parseOptionalUserId(payload.userId) } : {}),
        workerId: parseWorkerId(payload.workerId),
        model: parseModel(payload.model),
        price: parsePrice(payload.price),
        tps: parseTps(payload.tps),
        ...(Object.hasOwn(payload, 'enabled') ? { enabled: parseEnabled(payload.enabled) } : {})
    };
}

/**
 * Validates partial payload to update a worker-bound offer order.
 * @param {any} body
 * @returns {{ workerId?: string, model?: string, price?: number, tps?: number }}
 */
export function parseUpdateWorkerOrderBody(body) {
    const payload = body || {};
    const result = {
        ...(Object.hasOwn(payload, 'workerId') ? { workerId: parseWorkerId(payload.workerId) } : {}),
        ...(Object.hasOwn(payload, 'model') ? { model: parseModel(payload.model) } : {}),
        ...(Object.hasOwn(payload, 'price') ? { price: parsePrice(payload.price) } : {}),
        ...(Object.hasOwn(payload, 'tps') ? { tps: parseTps(payload.tps) } : {})
    };

    if (Object.keys(result).length < 1) {
        throw new HttpError(400, 'At least one field must be provided: workerId, model, price, tps.');
    }

    return result;
}

/**
 * Validates order id path parameter.
 * @param {unknown} value
 * @returns {number}
 */
export function parseOrderId(value) {
    const orderId = Number(value);
    if (!Number.isInteger(orderId) || orderId < 1) {
        throw new HttpError(400, 'orderId must be a positive integer.');
    }

    return orderId;
}

/**
 * @param {unknown} userId
 * @returns {string}
 */
function parseOptionalUserId(userId) {
    if (typeof userId !== 'string' || userId.trim().length < 1 || userId.trim().length > 128) {
        throw new HttpError(400, 'userId must be a non-empty string up to 128 characters when provided.');
    }

    return userId.trim();
}

/**
 * @param {unknown} workerId
 * @returns {string}
 */
function parseWorkerId(workerId) {
    if (typeof workerId !== 'string' || workerId.trim().length < 1 || workerId.trim().length > 128) {
        throw new HttpError(400, 'workerId must be a non-empty string up to 128 characters.');
    }

    return workerId.trim();
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function parseModel(model) {
    if (typeof model !== 'string' || model.trim().length < 1 || model.trim().length > 128) {
        throw new HttpError(400, 'model must be a non-empty string up to 128 characters.');
    }

    return model.trim();
}

/**
 * @param {unknown} price
 * @returns {number}
 */
function parsePrice(price) {
    const normalized = Number(price);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        throw new HttpError(400, 'price must be a positive number.');
    }

    return Number(normalized.toFixed(6));
}

/**
 * @param {unknown} tps
 * @returns {number}
 */
function parseTps(tps) {
    const normalized = Number(tps);
    if (!Number.isInteger(normalized) || normalized < 1) {
        throw new HttpError(400, 'tps must be a positive integer.');
    }

    return normalized;
}

/**
 * @param {unknown} enabled
 * @returns {boolean}
 */
function parseEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
        throw new HttpError(400, 'enabled must be a boolean.');
    }

    return enabled;
}
