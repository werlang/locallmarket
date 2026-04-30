import { HttpError } from './error.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates and normalizes payload for user registration.
 * @param {any} body
 * @returns {{ name?: string, email?: string }}
 */
export function parseCreateUserBody(body) {
    const payload = body || {};
    const name = normalizeString(payload.name, 'name');
    const email = normalizeOptionalEmail(payload.email);

    return {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email } : {})
    };
}

/**
 * Validates a user id path parameter.
 * @param {unknown} value
 * @returns {string}
 */
export function parseUserId(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(400, 'userId must be a non-empty string.');
    }

    return value.trim();
}

/**
 * Validates and normalizes payload for user profile updates.
 * @param {any} body
 * @returns {{ name?: string, email?: string }}
 */
export function parseUpdateUserBody(body) {
    const payload = body || {};
    const result = {};

    if (Object.hasOwn(payload, 'name')) {
        result.name = normalizeString(payload.name, 'name');
    }

    if (Object.hasOwn(payload, 'email')) {
        result.email = normalizeOptionalEmail(payload.email);
    }

    if (Object.keys(result).length === 0) {
        throw new HttpError(400, 'At least one field must be provided: name, email.');
    }

    return result;
}

/**
 * Validates recharge payload.
 * @param {any} body
 * @returns {number}
 */
export function parseRechargeBody(body) {
    const payload = body || {};
    const amount = Number(payload.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'amount must be a positive number.');
    }

    return amount;
}

/**
 * Validates and normalizes pagination query for user listing.
 * @param {any} query
 * @returns {{ limit: number, offset: number }}
 */
export function parseListUsersQuery(query) {
    const payload = query || {};
    const limit = parseOptionalPositiveInteger(payload.limit, 'limit', 100);
    const offset = parseOptionalNonNegativeInteger(payload.offset, 'offset', 0);

    return { limit, offset };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function normalizeString(value, field) {
    if (value === undefined) {
        throw new HttpError(400, `${field} is required.`);
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(400, `${field} must be a non-empty string.`);
    }

    return value.trim();
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeOptionalEmail(value) {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(400, 'email must be a non-empty string when provided.');
    }

    const normalized = value.trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalized)) {
        throw new HttpError(400, 'email must be a valid email address.');
    }

    return normalized;
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