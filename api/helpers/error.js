export class CustomError extends Error {

    /**
     * Creates an internal application error with optional debug payload.
     */
    constructor(message = 'Internal Server Error', data = null) {
        super(message);
        this.name = 'CustomError';
        this.data = data;
    }
}

export class HttpError extends CustomError {

    /**
     * Creates an HTTP error that is safe to expose to API consumers.
     */
    constructor(status = 500, message = 'Internal Server Error', data = null) {
        super(message, data);
        this.name = 'HttpError';
        this.status = Number.isInteger(Number(status)) ? Number(status) : 500;
        this.code = this.status;
        this.expose = true;
        this.type = null;
    }
}