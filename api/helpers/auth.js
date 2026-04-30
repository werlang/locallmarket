import { HttpError } from './error.js';

/**
 * Parses an API key from the Authorization header.
 * @param {Record<string, unknown>} headers
 * @returns {string}
 */
export function parseBearerApiKey(headers) {
    const raw = headers?.authorization ?? headers?.Authorization;

    if (typeof raw !== 'string') {
        throw new HttpError(401, 'Authorization header with Bearer token is required.');
    }

    const match = raw.match(/^Bearer\s+(.+)$/i);
    if (!match) {
        throw new HttpError(401, 'Authorization header with Bearer token is required.');
    }

    const apiKey = match[1].trim();
    if (!apiKey) {
        throw new HttpError(401, 'Authorization header with Bearer token is required.');
    }

    return apiKey;
}