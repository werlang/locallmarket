/**
 * No-operation stream for internal/automatic jobs that don't have an HTTP response.
 * Allows dispatch logic to work uniformly for both HTTP and programmatic flows.
 */
export class NoOpStream {
    constructor() {
        this._closed = false;
        this._events = [];
    }

    /**
     * Records the event but doesn't send it anywhere.
     */
    event(eventName) {
        return this;
    }

    /**
     * Buffers the data but doesn't send it anywhere.
     */
    send(data) {
        if (!this.closed) {
            this._events.push({ event: 'message', data });
        }
        return this;
    }

    /**
     * Marks the stream as closed.
     */
    close() {
        if (!this.closed) {
            this._closed = true;
        }
    }

    /**
     * Returns whether the stream is closed.
     */
    get closed() {
        return this._closed;
    }

    /**
     * Returns buffered events for inspection/logging.
     */
    getBufferedEvents() {
        return [...this._events];
    }
}
