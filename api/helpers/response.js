/**
 * Sends a success response using the orderbook API envelope contract.
 */
export function sendSuccess(res, { status = 200, body = {}, message } = {}) {
    const payload = {
        ok: true,
        ...body
    };

    if (message) {
        payload.message = message;
    }

    return res.status(status).json(payload);
}

/**
 * Sends a created response using the success envelope.
 */
export function sendCreated(res, { body = {}, message } = {}) {
    return sendSuccess(res, { status: 201, body, message });
}