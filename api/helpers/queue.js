import { randomUUID } from 'node:crypto';

/**
 * Simple FIFO queue for client stream jobs waiting on an available worker.
 */
export default class Queue {

    constructor() {
        this.queue = [];
    }

    /**
     * Adds a new item to the back of the queue.
     * @param {Record<string, any>} item
     * @returns {string}
     */
    add(item) {
        item.id ??= randomUUID();
        this.queue.push(item);
        return item.id;
    }

    /**
     * Re-adds an existing item to the front of the queue.
     * @param {Record<string, any>} item
     * @returns {string}
     */
    requeue(item) {
        item.id ??= randomUUID();
        this.queue.unshift(item);
        return item.id;
    }

    /**
     * Removes and returns the next queued item.
     * @returns {Record<string, any> | null}
     */
    shift() {
        return this.queue.shift() || null;
    }

    /**
     * Removes a queued item by identifier.
     * @param {string} id
     * @returns {Record<string, any> | null}
     */
    remove(id) {
        const index = this.queue.findIndex((item) => item.id === id);

        if (index === -1) {
            return null;
        }

        return this.queue.splice(index, 1)[0] || null;
    }

    /**
     * Returns the queue position for the provided identifier.
     * @param {string} id
     * @returns {number | null}
     */
    getPosition(id) {
        const position = this.queue.findIndex((item) => item.id === id);
        return position === -1 ? null : position + 1;
    }

    /**
     * Returns the current queue length.
     * @returns {number}
     */
    getSize() {
        return this.queue.length;
    }
}