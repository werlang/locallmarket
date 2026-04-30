import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { StreamRouter } from '../../../api/helpers/router.js';
import { ApiStreamClient } from '../../helpers/api-client.js';
import { LLM } from '../../model/llm.js';

class FakeSocket {

    constructor(name) {
        this.name = name;
        this.readyState = WebSocket.OPEN;
        this.workerId = undefined;
        this.activeJobId = null;
        this.handlers = new Map();
        this.sent = [];
        this.terminated = false;
    }

    on(eventName, handler) {
        const handlers = this.handlers.get(eventName) || [];
        handlers.push(handler);
        this.handlers.set(eventName, handlers);
    }

    emit(eventName, ...args) {
        for (const handler of this.handlers.get(eventName) || []) {
            handler(...args);
        }
    }

    send(message) {
        this.sent.push(JSON.parse(message));
    }

    terminate() {
        this.terminated = true;
        this.readyState = WebSocket.CLOSED;
    }
}

class FakeWSServer {

    constructor() {
        this.handlers = new Map();
        this.clients = new Set();
        this.connectionHandler = null;
    }

    onConnection(handler) {
        this.connectionHandler = handler;
    }

    connect(ws) {
        this.clients.add(ws);
        this.connectionHandler?.(ws);
    }

    on(type, handler) {
        this.handlers.set(type, handler);
    }

    emit(type, ws, payload) {
        this.handlers.get(type)?.(ws, payload);
    }

    send(ws, type, payload = {}) {
        if (ws.readyState !== WebSocket.OPEN) {
            throw new Error('Worker socket is not open.');
        }

        ws.send(JSON.stringify({ type, payload }));
    }

    broadcast(type, payload = {}) {
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type, payload }));
            }
        }
    }
}

class FakeStream {

    constructor() {
        this.currentEvent = 'message';
        this.events = [];
        this.closed = false;
    }

    event(eventName) {
        this.currentEvent = eventName;
        return this;
    }

    send(data) {
        this.events.push({ event: this.currentEvent, data });
        return this;
    }

    close() {
        this.closed = true;
    }
}

test('StreamRouter ignores stale socket events and does not free a reassigned worker', async () => {
    const wsServer = new FakeWSServer();
    const workersModel = {
        async bindConnectedWorker({ workerId, apiKey }) {
            if (!apiKey) {
                throw new Error('apiKey required');
            }

            return {
                worker: { id: workerId, userId: 'user-1' },
                user: { id: 'user-1' }
            };
        },
        async markDisconnected() {
            return undefined;
        }
    };
    const router = new StreamRouter({ wsServer, workersModel });
    const oldSocket = new FakeSocket('old-session');
    const newSocket = new FakeSocket('new-session');
    const firstStream = new FakeStream();
    const secondStream = new FakeStream();

    wsServer.connect(oldSocket);
    wsServer.emit('worker-register', oldSocket, { workerId: 'worker-1', apiKey: 'test-api-key' });
    await new Promise((resolve) => setImmediate(resolve));
    wsServer.emit('worker-ready', oldSocket);

    const firstJobId = router.enqueue({
        payload: { message: 'first request', model: 'ai/smollm2:135M-Q2_K' },
        stream: firstStream
    });

    wsServer.connect(newSocket);
    wsServer.emit('worker-register', newSocket, { workerId: 'worker-1', apiKey: 'test-api-key' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(oldSocket.terminated, true);
    assert.equal(router.getState().connectedWorkers, 1);
    assert.equal(router.getState().availableWorkers, 0);

    router.enqueue({
        payload: { message: 'second request', model: 'ai/smollm2:135M-Q2_K' },
        stream: secondStream
    });
    wsServer.emit('worker-ready', newSocket);

    assert.equal(newSocket.activeJobId !== null, true);
    assert.notEqual(newSocket.activeJobId, firstJobId);
    assert.equal(router.getState().activeJobs, 2);
    assert.equal(router.getState().availableWorkers, 0);

    wsServer.emit('stream-event', oldSocket, {
        jobId: firstJobId,
        event: 'message',
        data: 'stale chunk'
    });
    wsServer.emit('job-complete', oldSocket, { jobId: firstJobId });

    assert.deepEqual(firstStream.events, []);
    assert.equal(router.getState().activeJobs, 2);
    assert.equal(router.getState().availableWorkers, 0);
    assert.equal(newSocket.activeJobId !== null, true);

    oldSocket.emit('close');

    assert.equal(router.getState().connectedWorkers, 1);
    assert.equal(router.getState().activeJobs, 1);
    assert.equal(router.getState().availableWorkers, 0);
    assert.equal(firstStream.closed, true);
    assert.equal(secondStream.closed, false);
    assert.deepEqual(firstStream.events, [
        {
            event: 'error',
            data: JSON.stringify({ error: 'Worker disconnected while streaming the request.' })
        }
    ]);
});

test('ApiStreamClient keeps a disconnected job busy and does not leak late events onto a reconnected socket', async () => {
    const client = new ApiStreamClient({ url: 'ws://example.test/ws/workers', workerId: 'worker-1', apiKey: 'test-api-key' });
    const oldSocket = new FakeSocket('old-job-socket');
    const newSocket = new FakeSocket('new-job-socket');
    const originalStreamOutput = LLM.prototype.streamOutput;
    let reconnectCount = 0;
    let startStream;
    let resumeStream;

    client.scheduleReconnect = () => {
        reconnectCount += 1;
    };

    const streamStarted = new Promise((resolve) => {
        startStream = resolve;
    });
    const streamReleased = new Promise((resolve) => {
        resumeStream = resolve;
    });

    LLM.prototype.streamOutput = async (_input, stream) => {
        startStream();
        await streamReleased;
        stream.event('message').send('late chunk');
    };

    try {
        client.socket = oldSocket;

        const jobPromise = client.processJob({
            jobId: 'job-1',
            payload: { message: 'hello', model: 'ai/smollm2:135M-Q2_K' }
        });

        await streamStarted;

        assert.equal(client.busy, true);
        assert.equal(client.currentJobId, 'job-1');

        oldSocket.readyState = WebSocket.CLOSED;
        client.handleSocketClose(oldSocket);

        assert.equal(reconnectCount, 1);
        assert.equal(client.socket, null);
        assert.equal(client.busy, true);
        assert.equal(client.currentJobId, 'job-1');

        client.socket = newSocket;
        client.handleSocketOpen(newSocket);

        assert.deepEqual(newSocket.sent.map((entry) => entry.type), ['worker-register']);

        resumeStream();
        await jobPromise;

        assert.equal(client.busy, false);
        assert.equal(client.currentJobId, null);
        assert.deepEqual(oldSocket.sent, []);
        assert.deepEqual(newSocket.sent.map((entry) => entry.type), ['worker-register', 'worker-ready']);
    } finally {
        LLM.prototype.streamOutput = originalStreamOutput;
    }
});