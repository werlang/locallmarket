export class HttpStream {

    #res;
    #event;
    #closed;

    constructor(res) {
        applyStreamHeaders(res);

        this.#res = res;
        this.#event = 'message';
        this.#closed = false;
    }

    /**
     * Selects the SSE event name used for the next payload.
     * @param {string} event
     * @returns {Stream}
     */
    event(event) {
        this.#event = event;
        return this;
    }

    /**
     * Sends an SSE payload if the response is still writable.
     * @param {string} data
     * @returns {Stream}
     */
    send(data) {
        if (this.closed) {
            return this;
        }

        this.#res.write(`event: ${this.#event}\n`);
        this.#res.write(`data: ${data}\n\n`);
        return this;
    }

    /**
     * Closes the SSE response exactly once.
     */
    close() {
        if (this.closed) {
            return;
        }

        this.#closed = true;
        this.#res.end();
    }

    /**
     * Returns true when the underlying response can no longer be written.
     */
    get closed() {
        return this.#closed || this.#res.writableEnded;
    }
}

/**
 * Applies common SSE headers and status to an Express response.
 * @param {import('express').Response} res
 */
export function applyStreamHeaders(res) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }
}