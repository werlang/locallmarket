import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamRouter } from '../../helpers/router.js';

/**
 * Minimal mock WSServer that wires the StreamRouter event API without opening real sockets.
 */
function makeMockWsServer() {
    const handlers = new Map();
    let connectionCallback = null;
    const sent = [];

    return {
        onConnection(cb) { connectionCallback = cb; },
        on(method, cb) { handlers.set(method, cb); },
        broadcast() {},
        send(ws, type, payload) {
            if (!ws || ws.readyState !== 1) {
                throw new Error('Worker socket is not open.');
            }
            sent.push({ ws, type, payload });
        },
        // Test helpers
        _emit(method, ws, payload) { handlers.get(method)?.(ws, payload); },
        _connect(ws) { connectionCallback?.(ws); },
        _sent: sent
    };
}

/**
 * Creates a minimal mock WebSocket-like object.
 * @param {{ readyState?: number }} opts
 */
function makeMockSocket(opts = {}) {
    const listeners = {};
    const ws = {
        readyState: opts.readyState ?? 1,
        workerId: null,
        activeJobId: null,
        terminate: () => {},
        on(event, cb) { listeners[event] = cb; },
        _emit(event, ...args) { listeners[event]?.(...args); }
    };
    return ws;
}

/**
 * Fully registers a worker socket so it appears connected and available.
 * @param {StreamRouter} router
 * @param {object} wsServer
 * @param {object} ws
 * @param {string} workerId
 */
function registerAndReadyWorker(router, wsServer, ws, workerId) {
    wsServer._connect(ws);
    wsServer._emit('worker-register', ws, { workerId });
    wsServer._emit('worker-ready', ws);
}

test('queued targeted job is aborted and onJobAborted called when target worker disconnects', () => {
    const wsServer = makeMockWsServer();
    const router = new StreamRouter({ wsServer });

    const ws = makeMockSocket({ readyState: 0 }); // not open → dispatch finds no available worker
    wsServer._connect(ws);
    wsServer._emit('worker-register', ws, { workerId: 'w-offline' });
    // Do NOT emit worker-ready so worker stays unavailable

    let abortCalled = false;
    const mockStream = { closed: false, close() { this.closed = true; }, event() { return this; }, send() {} };

    router.enqueue({
        payload: { message: 'hello', model: 'llama' },
        stream: mockStream,
        targetWorkerId: 'w-offline',
        onJobAborted: () => { abortCalled = true; }
    });

    // Job should be in the queue targeting w-offline
    assert.equal(router.queue.getSize(), 1);
    assert.equal(abortCalled, false);

    // Worker disconnects → handleWorkerDisconnect fires
    ws._emit('close');

    // Queue should be empty and abort should have fired
    assert.equal(router.queue.getSize(), 0);
    assert.equal(abortCalled, true);
});

test('dispatched (active) targeted job does NOT trigger onJobAborted on worker disconnect', () => {
    const wsServer = makeMockWsServer();
    const router = new StreamRouter({ wsServer });

    const ws = makeMockSocket({ readyState: 1 });
    registerAndReadyWorker(router, wsServer, ws, 'w-active');

    let abortCalled = false;
    const events = [];
    const mockStream = {
        closed: false,
        close() { this.closed = true; },
        event(e) { events.push(e); return this; },
        send() {}
    };

    const jobId = router.enqueue({
        payload: { message: 'test', model: 'llama' },
        stream: mockStream,
        targetWorkerId: 'w-active',
        onJobAborted: () => { abortCalled = true; }
    });

    // Job should be active (dispatched), not queued
    assert.equal(router.queue.getSize(), 0);
    assert.equal(router.activeJobs.has(jobId), true);
    assert.equal(abortCalled, false);

    // Worker disconnects → finishJob handles the active job, not onJobAborted
    ws._emit('close');

    assert.equal(abortCalled, false, 'onJobAborted must not fire for already-dispatched jobs');
    assert.equal(mockStream.closed, true, 'stream must be closed by finishJob');
    // An error event should have been sent
    assert.ok(events.includes('error'), 'error event expected from finishJob on worker disconnect');
});

test('stale session event is ignored after worker reconnect', () => {
    const wsServer = makeMockWsServer();
    const router = new StreamRouter({ wsServer });

    const wsOld = makeMockSocket({ readyState: 1 });
    registerAndReadyWorker(router, wsServer, wsOld, 'w-reconnect');

    const events = [];
    const mockStream = {
        closed: false,
        close() { this.closed = true; },
        event(e) { events.push(e); return this; },
        send() {}
    };

    // Enqueue a job that gets dispatched to wsOld
    const jobId = router.enqueue({
        payload: { message: 'msg', model: 'llama' },
        stream: mockStream,
        targetWorkerId: 'w-reconnect'
    });
    assert.equal(router.activeJobs.has(jobId), true);

    // Reconnect with a new socket (replaces old entry)
    const wsNew = makeMockSocket({ readyState: 1 });
    wsServer._connect(wsNew);
    wsServer._emit('worker-register', wsNew, { workerId: 'w-reconnect' });
    wsServer._emit('worker-ready', wsNew);

    // Old socket emits a stream-event — must be ignored since worker.ws !== wsOld now
    const initialEventCount = events.length;
    wsServer._emit('stream-event', wsOld, { jobId, event: 'message', data: 'stale data' });
    assert.equal(events.length, initialEventCount, 'stale stream-event from old socket must be ignored');
});

test('targeted job without onJobAborted does not error on worker disconnect', () => {
    const wsServer = makeMockWsServer();
    const router = new StreamRouter({ wsServer });

    const ws = makeMockSocket({ readyState: 0 });
    wsServer._connect(ws);
    wsServer._emit('worker-register', ws, { workerId: 'w-noabort' });

    const mockStream = { closed: false, close() { this.closed = true; }, event() { return this; }, send() {} };

    router.enqueue({
        payload: { message: 'hi', model: 'llama' },
        stream: mockStream,
        targetWorkerId: 'w-noabort'
        // No onJobAborted
    });

    // Worker disconnects — should not throw even without a callback
    assert.doesNotThrow(() => ws._emit('close'));
    assert.equal(router.queue.getSize(), 0);
});

test('job-complete persists observed worker TPS using completion usage and elapsed job time', async () => {
    const wsServer = makeMockWsServer();
    const updateCalls = [];
    const originalNow = Date.now;

    const router = new StreamRouter({
        wsServer,
        workersModel: {
            async bindConnectedWorker({ workerId }) {
                return {
                    worker: { id: workerId, userId: 'owner-1' },
                    user: { id: 'owner-1' }
                };
            },
            async markDisconnected() {
                return undefined;
            },
            async updatePerformanceTps(input) {
                updateCalls.push(input);
                return 30;
            }
        }
    });

    try {
        const ws = makeMockSocket({ readyState: 1 });
        wsServer._connect(ws);
        wsServer._emit('worker-register', ws, { workerId: 'w-tps' });
        await new Promise((resolve) => setImmediate(resolve));
        wsServer._emit('worker-ready', ws);

        const mockStream = { closed: false, close() { this.closed = true; }, event() { return this; }, send() {} };
        const jobId = router.enqueue({
            payload: { message: 'performance', model: 'llama' },
            stream: mockStream,
            targetWorkerId: 'w-tps'
        });

        const activeJob = router.activeJobs.get(jobId);
        assert.ok(activeJob);
        activeJob.startedAtMs = 1000;

        Date.now = () => 3000;

        wsServer._emit('job-complete', ws, {
            jobId,
            usage: { completion_tokens: 60 }
        });

        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(updateCalls.length, 1);
        assert.deepEqual(updateCalls[0], {
            workerId: 'w-tps',
            model: 'llama',
            usage: { completion_tokens: 60 },
            startedAtMs: 1000,
            completedAtMs: 3000
        });
        assert.equal(router.activeJobs.has(jobId), false);
    } finally {
        Date.now = originalNow;
    }
});

test('job-complete from stale replaced socket is ignored for TPS persistence', async () => {
    const wsServer = makeMockWsServer();
    const updateCalls = [];

    const router = new StreamRouter({
        wsServer,
        workersModel: {
            async bindConnectedWorker({ workerId }) {
                return {
                    worker: { id: workerId, userId: 'owner-1' },
                    user: { id: 'owner-1' }
                };
            },
            async markDisconnected() {
                return undefined;
            },
            async updatePerformanceTps(input) {
                updateCalls.push(input);
                return 25;
            }
        }
    });

    const wsOld = makeMockSocket({ readyState: 1 });
    wsServer._connect(wsOld);
    wsServer._emit('worker-register', wsOld, { workerId: 'w-replaced' });
    await new Promise((resolve) => setImmediate(resolve));
    wsServer._emit('worker-ready', wsOld);

    const mockStream = { closed: false, close() { this.closed = true; }, event() { return this; }, send() {} };
    const jobId = router.enqueue({
        payload: { message: 'performance', model: 'llama' },
        stream: mockStream,
        targetWorkerId: 'w-replaced'
    });
    assert.equal(router.activeJobs.has(jobId), true);

    const wsNew = makeMockSocket({ readyState: 1 });
    wsServer._connect(wsNew);
    wsServer._emit('worker-register', wsNew, { workerId: 'w-replaced' });
    await new Promise((resolve) => setImmediate(resolve));
    wsServer._emit('worker-ready', wsNew);

    wsServer._emit('job-complete', wsOld, {
        jobId,
        usage: { completion_tokens: 99 }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(updateCalls.length, 0);
    assert.equal(router.activeJobs.has(jobId), true);
});
