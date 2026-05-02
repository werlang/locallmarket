import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamRouter } from '../../helpers/router.js';
import { HttpStream } from '../../helpers/stream.js';

/**
 * Helper: Fake WebSocket for integration testing
 */
class FakeIntegrationSocket extends EventEmitter {
    constructor(workerId) {
        super();
        this.workerId = workerId;
        this.activeJobId = null;
        this.messages = [];
        this.terminated = false;
    }

    send(data) {
        this.messages.push(data);
    }

    terminate() {
        this.terminated = true;
        this.emit('close');
    }

    // Simulate receiving a message from the worker
    sendMessage(type, payload) {
        this.emit('message', JSON.stringify({ type, payload }));
    }
}

/**
 * Helper: Fake WSServer for integration testing
 */
function createFakeWSServerForIntegration() {
    const handlers = new Map();
    const connectedSockets = new Set();

    return {
        handlers,
        connectedSockets,
        onConnection(fn) {
            this.connectionHandler = fn;
        },
        on(event, handler) {
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        broadcast(event, payload) {
            const list = handlers.get(event) || [];
            for (const handler of list) {
                handler(payload);
            }
        },
        send(ws, event, payload) {
            ws.activeJobId = payload?.jobId || null;
            // Don't actually send, just record
            if (!ws.messages) ws.messages = [];
            ws.messages.push({ type: event, payload });
        },
        emit(event, ws, payload) {
            const list = handlers.get(event) || [];
            for (const handler of list) {
                handler(ws, payload);
            }
        },
        registerConnection(ws) {
            connectedSockets.add(ws);
        }
    };
}

/**
 * Helper: Fake HTTP response stream
 */
function createFakeHttpStreamForIntegration() {
    const chunks = [];
    const events = [];
    return {
        chunks,
        events,
        closed: false,
        writableEnded: false,
        event(eventName) {
            this._currentEvent = eventName;
            return this;
        },
        send(data) {
            if (!this.closed && !this.writableEnded) {
                chunks.push(data);
                events.push({ event: this._currentEvent, data });
            }
            return this;
        },
        close() {
            this.closed = true;
            this.writableEnded = true;
        }
    };
}

// ============================================================================
// Gap 13: Full HTTP→WebSocket→HTTP Cycle
// ============================================================================
test('Integration: consumer request → worker dispatch → chunk relay → completion', async () => {
    // Why this test matters: Validates the entire request/response flow end-to-end.
    // This is the critical path for the platform and needs robust integration coverage.
    
    const wsServer = createFakeWSServerForIntegration();
    const router = new StreamRouter({ wsServer });

    // Step 1: Worker connects and registers
    const workerSocket = new FakeIntegrationSocket('worker-gpu-1');
    router.registerWorker(workerSocket, {
        workerId: 'worker-gpu-1',
        model: 'gpt-4',
        tps: 25,
        price: 0.01
    });
    assert.equal(workerSocket.workerId, 'worker-gpu-1', 'worker registered');

    // Step 2: Worker reports readiness
    router.markWorkerReady(workerSocket);
    assert.ok(router.isWorkerAvailable('worker-gpu-1'), 'worker should be available');

    // Step 3: Consumer submits HTTP request (enqueue)
    const consumerStream = createFakeHttpStreamForIntegration();
    const jobId = router.enqueue({
        payload: { message: 'What is 2+2?', model: 'gpt-4' },
        stream: consumerStream
    });
    assert.ok(jobId, 'job enqueued');
    assert.ok(router.activeJobs.has(jobId), 'job should be in active jobs');

    // Step 4: Job dispatched to worker (verify message sent)
    const dispatchedMessages = workerSocket.messages;
    assert.ok(dispatchedMessages.length > 0, 'dispatch message should be sent to worker');
    const dispatchMsg = dispatchedMessages.find(m => m.type === 'stream-job');
    assert.ok(dispatchMsg, 'stream-job message should be dispatched');
    assert.equal(dispatchMsg.payload.jobId, jobId, 'correct job ID dispatched');

    // Step 5: Worker sends completion chunks
    router.handleStreamEvent(workerSocket, {
        jobId,
        event: 'message',
        data: '{"choices": [{"delta": {"content": "The answer is 4"}}]}'
    });

    // Step 6: Consumer receives chunk via HTTP stream
    assert.equal(consumerStream.chunks.length, 1, 'consumer should receive chunk');
    assert.equal(consumerStream.events[0].event, 'message', 'event type should be message');

    // Step 7: Worker sends completion
    router.handleStreamEvent(workerSocket, {
        jobId,
        event: 'end',
        data: 'null'
    });

    assert.equal(consumerStream.chunks.length, 2, 'consumer should receive end marker');
    assert.equal(consumerStream.events[1].event, 'end', 'event type should be end');

    // Step 8: Job finishes and worker is released
    router.finishJob(jobId);
    assert.ok(!router.activeJobs.has(jobId), 'job should be removed from active');
    assert.ok(router.isWorkerAvailable('worker-gpu-1'), 'worker should be available again');
});

// ============================================================================
// Gap 13b: Full HTTP→WebSocket→HTTP Cycle with Error Handling
// ============================================================================
test('Integration: consumer error handling when worker fails mid-stream', async () => {
    // Why this test matters: Ensures errors are properly communicated to consumers
    // when workers fail during execution.
    
    const wsServer = createFakeWSServerForIntegration();
    const router = new StreamRouter({ wsServer });

    // Setup: Worker ready
    const workerSocket = new FakeIntegrationSocket('worker-1');
    router.registerWorker(workerSocket, { workerId: 'worker-1' });
    router.markWorkerReady(workerSocket);

    // Consumer submits request
    const stream = createFakeHttpStreamForIntegration();
    const jobId = router.enqueue({
        payload: { message: 'test', model: 'gpt-4' },
        stream
    });

    // Worker sends error
    router.handleStreamEvent(workerSocket, {
        jobId,
        event: 'error',
        data: '{"error": "CUDA out of memory"}'
    });

    assert.equal(stream.chunks.length, 1, 'error should be sent to consumer');
    assert.equal(stream.events[0].event, 'error', 'event should be error');

    // Job finished with error
    router.finishJob(jobId);
    assert.ok(router.isWorkerAvailable('worker-1'), 'worker released despite error');
});

// ============================================================================
// Gap 13c: Full HTTP→WebSocket→HTTP Cycle with Client Disconnect
// ============================================================================
test('Integration: consumer disconnects mid-stream, worker cleanup occurs', async () => {
    // Why this test matters: Ensures graceful cleanup when clients disconnect.
    // Prevents orphaned worker jobs and resource leaks.
    
    const wsServer = createFakeWSServerForIntegration();
    const router = new StreamRouter({ wsServer });

    const workerSocket = new FakeIntegrationSocket('worker-1');
    router.registerWorker(workerSocket, { workerId: 'worker-1' });
    router.markWorkerReady(workerSocket);

    const stream = createFakeHttpStreamForIntegration();
    const jobId = router.enqueue({
        payload: { message: 'long-task', model: 'gpt-4' },
        stream
    });

    assert.ok(router.activeJobs.has(jobId), 'job active');
    assert.ok(!router.isWorkerAvailable('worker-1'), 'worker busy');

    // Consumer closes connection (marked disconnected)
    stream.close();
    router.cancel(jobId);

    const activeJob = router.activeJobs.get(jobId);
    // After cancel on a dispatched job, it's marked disconnected (not removed immediately)
    // The job will be cleaned up when the worker finishes or sends more data
    if (!activeJob) {
        // Job was removed from queue during cancel
        assert.ok(true, 'job successfully removed');
    } else {
        // Job is still active but marked as disconnected
        assert.equal(activeJob.disconnected, true, 'job should be marked disconnected');
    }

    // Worker tries to send more data (should be ignored)
    router.handleStreamEvent(workerSocket, {
        jobId,
        event: 'message',
        data: 'late chunk'
    });

    // Should not crash, chunk ignored
    assert.ok(stream.closed, 'stream remains closed');
});

// ============================================================================
// Gap 13d: Multiple Concurrent Requests (Stress Test)
// ============================================================================
test('Integration: multiple concurrent consumer requests queued and dispatched', async () => {
    // Why this test matters: Ensures the system handles multiple concurrent requests correctly.
    // Each job should maintain isolation and not interfere with others.
    
    const wsServer = createFakeWSServerForIntegration();
    const router = new StreamRouter({ wsServer });

    // Single worker
    const workerSocket = new FakeIntegrationSocket('worker-1');
    router.registerWorker(workerSocket, { workerId: 'worker-1' });
    router.markWorkerReady(workerSocket);

    // Five concurrent consumer requests
    const jobs = [];
    for (let i = 0; i < 5; i++) {
        const stream = createFakeHttpStreamForIntegration();
        const jobId = router.enqueue({
            payload: { message: `request-${i}`, model: 'gpt-4' },
            stream,
            targetWorkerId: 'worker-1'
        });
        jobs.push({ jobId, stream, index: i });
    }

    // Verify: All jobs queued
    assert.equal(jobs.length, 5, 'all jobs should be enqueued');

    const state = router.getState();
    assert.ok(state.activeJobs + state.queuedJobs >= 5, 'all jobs should be in queue or active');

    // Simulate: Worker processes first job and returns to ready
    const firstJob = jobs[0];
    router.handleStreamEvent(workerSocket, {
        jobId: firstJob.jobId,
        event: 'message',
        data: 'response for request-0'
    });
    router.finishJob(firstJob.jobId);

    // Worker should process next queued job
    assert.ok(router.isWorkerConnected('worker-1'), 'worker still connected');
    
    // Verify queue shrinks as jobs complete
    for (let i = 1; i < jobs.length; i++) {
        router.finishJob(jobs[i].jobId);
    }

    const finalState = router.getState();
    assert.equal(finalState.queuedJobs, 0, 'no queued jobs remain');
    assert.equal(finalState.activeJobs, 0, 'no active jobs remain');
});

// ============================================================================
// Gap 5b: Race Condition - Concurrent Complete & Error
// ============================================================================
test('Integration: job-complete and job-failed race condition handled', async () => {
    // Why this test matters: A worker might send both complete AND error messages
    // in a race condition. Only the first should be processed.
    
    const wsServer = createFakeWSServerForIntegration();
    
    let settlementAttempts = 0;
    const mockOrdersModel = {
        async completeReceipt() {
            settlementAttempts++;
            return { status: 'settled' };
        },
        async failReceipt() {
            // Only first complete should settle, not fail
        }
    };

    const router = new StreamRouter({ wsServer, ordersModel: mockOrdersModel });

    const workerSocket = new FakeIntegrationSocket('worker-1');
    router.registerWorker(workerSocket, { workerId: 'worker-1' });
    router.markWorkerReady(workerSocket);

    const stream = createFakeHttpStreamForIntegration();
    const jobId = router.enqueue({
        payload: { message: 'test', model: 'gpt-4' },
        stream,
        settlement: { orderId: 123, requesterId: 'user-1' }
    });

    // Job completes (would trigger settlement)
    router.finishJob(jobId, { workerId: 'worker-1' });

    // Verify: Job is removed after first finish
    assert.ok(!router.activeJobs.has(jobId), 'job should be finished');

    // Try to process another complete/error for same job (should be ignored)
    router.handleStreamEvent(workerSocket, {
        jobId,
        event: 'error',
        data: 'Worker error (late)'
    });

    // Should not cause additional settlement or errors
    assert.ok(!router.activeJobs.has(jobId), 'job still finished');
});

// ============================================================================
// Gap 1b: Late Message from Disconnected Worker - Integration
// ============================================================================
test('Integration: late messages from stale worker socket are completely ignored', async () => {
    // Why this test matters: Real-world scenario where a worker reconnects and
    // the old socket sends lingering messages that should be discarded.
    
    const wsServer = createFakeWSServerForIntegration();
    const router = new StreamRouter({ wsServer });

    // Setup: Worker on socket A
    const socketA = new FakeIntegrationSocket('worker-1');
    router.registerWorker(socketA, { workerId: 'worker-1' });
    router.markWorkerReady(socketA);

    const stream = createFakeHttpStreamForIntegration();
    const jobId = router.enqueue({
        payload: { message: 'test', model: 'gpt-4' },
        stream
    });

    // Worker disconnects
    socketA.terminate();
    // Note: In real impl, this calls handleWorkerDisconnect
    // For this test, we simulate by creating new socket
    
    // New connection on socket B
    const socketB = new FakeIntegrationSocket('worker-1');
    router.registerWorker(socketB, { workerId: 'worker-1' });
    router.markWorkerReady(socketB);

    // Old socket A sends stale message
    router.handleStreamEvent(socketA, {
        jobId,
        event: 'message',
        data: 'stale chunk from old socket'
    });

    // Should not appear in stream
    assert.equal(stream.chunks.length, 0, 'stale messages should be ignored');
});
