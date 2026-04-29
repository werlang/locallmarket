import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { StreamRouter } from '../../helpers/router.js';

// ── Fakes ──────────────────────────────────────────────────────────────────

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
        this.broadcasts = [];
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
        this.broadcasts.push({ type, payload });
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('StreamRouter', () => {
    it('getState() returns zero counts on init', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        assert.deepEqual(router.getState(), {
            connectedWorkers: 0,
            availableWorkers: 0,
            activeJobs: 0,
            queuedJobs: 0
        });
    });

    it('enqueue() returns a string id', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const stream = new FakeStream();
        const id = router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
    });

    it('enqueue() with an available worker dispatches immediately', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });
        wsServer.emit('worker-ready', ws);

        const stream = new FakeStream();
        const jobId = router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });

        assert.equal(router.getState().activeJobs, 1);
        assert.equal(router.getState().queuedJobs, 0);
        // Worker should no longer be available after dispatch
        assert.equal(router.getState().availableWorkers, 0);
        // Worker socket received the stream-job message
        const jobMsg = ws.sent.find(m => m.type === 'stream-job');
        assert.ok(jobMsg);
        assert.equal(jobMsg.payload.jobId, jobId);
    });

    it('enqueue() with no workers broadcasts worker-ready-request', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const stream = new FakeStream();
        wsServer.broadcasts = [];
        router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });
        const broadcast = wsServer.broadcasts.find(b => b.type === 'worker-ready-request');
        assert.ok(broadcast);
    });

    it('cancel() on a queued job removes it from the queue', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const stream = new FakeStream();
        const jobId = router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });
        assert.equal(router.getState().queuedJobs, 1);
        router.cancel(jobId);
        assert.equal(router.getState().queuedJobs, 0);
    });

    it('cancel() on an active job sets job.disconnected to true', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });
        wsServer.emit('worker-ready', ws);

        const stream = new FakeStream();
        const jobId = router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });

        assert.equal(router.getState().activeJobs, 1);
        router.cancel(jobId);
        const job = router.activeJobs.get(jobId);
        assert.ok(job);
        assert.equal(job.disconnected, true);
    });

    it('registerWorker() registers a worker by provided id', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('sock');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'my-worker' });

        assert.equal(router.workers.has('my-worker'), true);
        assert.equal(ws.workerId, 'my-worker');
    });

    it('registerWorker() terminates the old socket on re-register with same id', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const oldWs = new FakeSocket('old');
        const newWs = new FakeSocket('new');

        wsServer.connect(oldWs);
        wsServer.emit('worker-register', oldWs, { workerId: 'shared-id' });
        assert.equal(oldWs.terminated, false);

        wsServer.connect(newWs);
        wsServer.emit('worker-register', newWs, { workerId: 'shared-id' });
        assert.equal(oldWs.terminated, true);
        assert.equal(router.workers.get('shared-id').ws, newWs);
    });

    it('markWorkerReady() sets worker available and triggers dispatch', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });

        // Enqueue before marking ready so the job is waiting
        const stream = new FakeStream();
        router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });
        assert.equal(router.getState().queuedJobs, 1);

        wsServer.emit('worker-ready', ws);
        assert.equal(router.getState().queuedJobs, 0);
        assert.equal(router.getState().activeJobs, 1);
    });

    it('handleStreamEvent() forwards event data to the job stream', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });
        wsServer.emit('worker-ready', ws);

        const stream = new FakeStream();
        const jobId = router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });

        wsServer.emit('stream-event', ws, { jobId, event: 'message', data: 'chunk' });

        assert.equal(stream.events.length, 1);
        assert.deepEqual(stream.events[0], { event: 'message', data: 'chunk' });
    });

    it('handleStreamEvent() is ignored when jobId does not match worker current job', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });
        wsServer.emit('worker-ready', ws);

        const stream = new FakeStream();
        router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });

        wsServer.emit('stream-event', ws, { jobId: 'wrong-id', event: 'message', data: 'stale' });

        assert.equal(stream.events.length, 0);
    });

    it('handleWorkerDisconnect() removes the worker and finishes the active job with error', () => {
        const wsServer = new FakeWSServer();
        const router = new StreamRouter({ wsServer });
        const ws = new FakeSocket('w1');
        wsServer.connect(ws);
        wsServer.emit('worker-register', ws, { workerId: 'w1' });
        wsServer.emit('worker-ready', ws);

        const stream = new FakeStream();
        router.enqueue({ payload: { message: 'hi', model: 'test' }, stream });

        assert.equal(router.getState().connectedWorkers, 1);
        assert.equal(router.getState().activeJobs, 1);

        // Simulate disconnect
        ws.emit('close');

        assert.equal(router.getState().connectedWorkers, 0);
        assert.equal(router.getState().activeJobs, 0);
        // An error event should have been sent on the stream
        const errorEvent = stream.events.find(e => e.event === 'error');
        assert.ok(errorEvent, 'Expected an error event on the stream');
        assert.equal(stream.closed, true);
    });
});
