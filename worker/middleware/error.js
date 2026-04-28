const ERROR_TYPES = {
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    504: 'Gateway Timeout',
};

/**
 * Converts thrown errors into the API error envelope.
 */
export function errorMiddleware(err, req, res, next) {
    if (!err) {
        next();
        return;
    }

    const status = Number.isInteger(err.status)
        ? err.status
        : (Number.isInteger(err.code) ? err.code : 500);

    const safeStatus = ERROR_TYPES[status] ? status : 500;
    const payload = {
        error: true,
        status: safeStatus,
        type: err.type || ERROR_TYPES[safeStatus],
        message: err.message || ERROR_TYPES[safeStatus] || 'Internal Server Error',
    };

    if (process.env.NODE_ENV !== 'production') {
        if (err.data !== undefined && err.data !== null) {
            payload.data = err.data;
        }
    }

    res.status(safeStatus).json(payload);
}
