import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { LLM } from '../model/llm.js';

const DEFAULT_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;

class SocketStream {

    constructor(client, socket, jobId) {
        this.client = client;
        this.socket = socket;
        this.jobId = jobId;
        this.eventName = 'message';
    }

    event(eventName) {
        this.eventName = eventName;
        return this;
    }

    send(data) {
        this.client.sendToSocket(this.socket, 'stream-event', {
            jobId: this.jobId,
            event: this.eventName,
            data
        });

        return this;
    }
}

/**
 * Maintains the persistent worker-to-API socket used for stream job delivery.
 */
export class ApiStreamClient {

    /**
     * @param {{ url?: string, workerId?: string, apiKey?: string, model?: string, tps?: number, price?: number }} options
     */
    constructor({
        url = 'ws://127.0.0.1:3000/ws/workers',
        workerId = `worker-${randomUUID()}`,
        apiKey = process.env.WORKER_USER_API_KEY,
        model = process.env.WORKER_MODEL,
        tps = process.env.WORKER_TPS ? Number(process.env.WORKER_TPS) : undefined,
        price = process.env.WORKER_PRICE ? Number(process.env.WORKER_PRICE) : undefined
    } = {}) {
        this.url = url;
        this.workerId = workerId;
        this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        this.model = typeof model === 'string' ? model.trim() : '';
        this.tps = Number.isFinite(tps) ? tps : null;
        this.price = Number.isFinite(price) ? price : null;
        this.socket = null;
        this.busy = false;
        this.currentJobId = null;
        this.reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
        this.reconnectTimer = null;
    }

    /**
     * Opens the persistent API connection and re-registers the worker state.
     */
    connect() {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const socket = new WebSocket(this.url);
        this.socket = socket;

        socket.on('open', () => {
            this.handleSocketOpen(socket);
        });

        socket.on('message', (message) => {
            this.handleMessage(message);
        });

        socket.on('close', () => {
            this.handleSocketClose(socket);
        });

        socket.on('error', (error) => {
            console.error('API WebSocket error:', error?.message || error);
        });
    }

    /**
     * Re-registers the worker when a socket session opens.
     * @param {WebSocket} socket
     */
    handleSocketOpen(socket) {
        if (this.socket !== socket) {
            return;
        }

        if (!this.apiKey) {
            console.error('WORKER_USER_API_KEY is required for worker registration. Closing socket.');
            socket.close();
            return;
        }

        if (!this.model || this.tps == null || this.price == null) {
            console.error('WORKER_MODEL, WORKER_TPS, and WORKER_PRICE are required for worker registration. Closing socket.');
            socket.close();
            return;
        }

        console.log(`Connected to API WebSocket ${this.url} as ${this.workerId}`);
        this.reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
        this.sendToSocket(socket, 'worker-register', {
            workerId: this.workerId,
            apiKey: this.apiKey,
            model: this.model,
            tps: this.tps,
            price: this.price
        });
        this.sendReady();
    }

    /**
     * Keeps an in-flight job quarantined when its socket session drops.
     * @param {WebSocket} socket
     */
    handleSocketClose(socket) {
        if (this.socket !== socket) {
            return;
        }

        console.warn('Disconnected from API WebSocket. Scheduling reconnect.');
        this.socket = null;
        this.scheduleReconnect();
    }

    /**
     * Handles control and job messages pushed by the API.
     * @param {string | Buffer} message
     */
    handleMessage(message) {
        let parsed;

        try {
            parsed = JSON.parse(String(message));
        } catch {
            return;
        }

        const { type, payload } = parsed;

        if (type === 'worker-ready-request') {
            if (!this.busy) {
                this.sendReady();
            }
            return;
        }

        if (type === 'stream-job') {
            void this.processJob(payload);
        }
    }

    /**
     * Runs a single stream job against the model runner and relays events.
     * @param {{ jobId?: string, payload?: { message?: string, model?: string, host?: string } }} payload
     */
    async processJob(payload) {
        const jobId = payload?.jobId;
        const request = payload?.payload;

        if (this.busy) {
            this.send('job-failed', {
                jobId,
                error: 'Worker is already processing another request.'
            });
            return;
        }

        if (typeof jobId !== 'string'
            || typeof request?.message !== 'string'
            || request.message.trim().length === 0
            || typeof request?.model !== 'string'
            || request.model.trim().length === 0) {
            this.send('job-failed', {
                jobId,
                error: 'Invalid stream job payload.'
            });
            this.sendReady();
            return;
        }

        this.busy = true;
        this.currentJobId = jobId;

        const jobSocket = this.socket;
        const stream = new SocketStream(this, jobSocket, jobId);

        try {
            console.log(`[${new Date().toISOString()}] Received job ${jobId}. Forwarding to model runner at ${request.host || process.env.MODEL_RUNNER_HOST}...`);
            const llm = new LLM({
                model: request.model,
                host: request.host || process.env.MODEL_RUNNER_HOST
            });

            const usage = await llm.streamOutput(request.message, stream);
            console.log(`[${new Date().toISOString()}] Completed job ${jobId}.`);
            this.sendToSocket(jobSocket, 'job-complete', { jobId, usage });
        } catch (error) {
            const message = error?.message || 'Failed to process stream job.';
            stream.event('error').send(JSON.stringify({ error: message }));
            this.sendToSocket(jobSocket, 'job-failed', {
                jobId,
                error: message
            });
        } finally {
            if (this.currentJobId === jobId) {
                this.busy = false;
                this.currentJobId = null;
            }

            this.sendReady();
        }
    }

    /**
     * Sends an explicit ready event to the API when the worker is idle.
     */
    sendReady() {
        if (this.busy) {
            return false;
        }

        return this.send('worker-ready', {
            workerId: this.workerId
        });
    }

    /**
     * Sends a typed message to the API when the socket is open.
     * @param {string} type
     * @param {Record<string, any>} payload
     * @returns {boolean}
     */
    send(type, payload = {}) {
        return this.sendToSocket(this.socket, type, payload);
    }

    /**
     * Sends a typed message to a specific socket when that session is still open.
     * @param {WebSocket | null} socket
     * @param {string} type
     * @param {Record<string, any>} payload
     * @returns {boolean}
     */
    sendToSocket(socket, type, payload = {}) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return false;
        }

        socket.send(JSON.stringify({ type, payload }));
        return true;
    }

    /**
     * Schedules a reconnect with bounded exponential backoff.
     */
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
            this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
        }, this.reconnectDelayMs);
    }
}