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
