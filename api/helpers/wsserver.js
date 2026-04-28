import { WebSocket, WebSocketServer } from 'ws';

/**
 * WebSocket server wrapper for worker registration and event routing.
 */
export class WSServer {

    /**
     * @param {{ port: number, path?: string }} options
     */
    constructor({ port = 3000, path = '/ws/workers' } = {}) {
        this.ws = new WebSocketServer({ port, path });
        this.methodList = new Map();
        this.connectionCallback = null;

        this.ws.on('connection', (socket, request) => {
            if (this.connectionCallback) {
                this.connectionCallback(socket, request);
            }

            socket.on('message', (message) => {
                this.handleMessage(socket, message);
            });

            socket.on('error', (error) => {
                console.error('Worker socket error:', error);
            });
        });
    }

    /**
     * Registers a callback for raw worker socket connections.
     * @param {(ws: import('ws').WebSocket, request: import('http').IncomingMessage) => void} callback
     */
    onConnection(callback) {
        this.connectionCallback = callback;
    }

    /**
     * Routes a parsed worker message to a registered method handler.
     * @param {import('ws').WebSocket} ws
     * @param {string | Buffer} message
     */
    handleMessage(ws, message) {
        let parsed;

        try {
            parsed = JSON.parse(String(message));
        } catch {
            return;
        }

        const { type, payload } = parsed;
        if (!type || typeof type !== 'string') {
            return;
        }

        const handler = this.methodList.get(type);
        if (!handler) {
            return;
        }

        handler(ws, payload);
    }

    /**
     * Registers a callback for a specific worker message type.
     * @param {string} method
     * @param {(ws: import('ws').WebSocket, payload: any) => void} callback
     */
    on(method, callback) {
        this.methodList.set(method, callback);
    }

    /**
     * Sends a typed message to a single worker socket.
     * @param {import('ws').WebSocket} ws
     * @param {string} type
     * @param {Record<string, any>} payload
     */
    send(ws, type, payload = {}) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Worker socket is not open.');
        }

        ws.send(JSON.stringify({ type, payload }));
    }

    /**
     * Broadcasts a typed message to every connected worker.
     * @param {string} type
     * @param {Record<string, any>} payload
     */
    broadcast(type, payload = {}) {
        for (const client of this.ws.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type, payload }));
            }
        }
    }
}