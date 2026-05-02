import test from 'node:test';
import assert from 'node:assert/strict';

import { openAiRouterFactory } from '../../routes/openai.js';
import { ordersModel } from '../../models/orders.js';
import { workersModel } from '../../models/workers.js';
import { usersModel } from '../../models/users.js';

function makeMockRes() {
    const headers = {};
    const written = [];
    let headersSent = false;
    let writableEnded = false;
    let flushed = false;
    const closeListeners = [];

    return {
        get headersSent() { return headersSent; },
        get writableEnded() { return writableEnded; },
        status() { return this; },
        setHeader(name, value) { headers[name] = value; return this; },
        flushHeaders() { headersSent = true; flushed = true; return this; },
        write(chunk) { written.push(String(chunk)); return true; },
        end() { writableEnded = true; },
        once(event, handler) {
            if (event === 'close') {
                closeListeners.push(handler);
            }
        },
        emitClose() {
            for (const handler of closeListeners) {
                handler();
            }
        },
        get _flushed() { return flushed; },
        _headers: headers,
        _written: written
    };
}

function getPostHandler(router, path) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer, `Expected route ${path} to exist`);
    assert.ok(layer.route.methods.post, `Expected route ${path} to support POST`);
    return layer.route.stack[0].handle;
}

test('openAiRouterFactory /chat/completions finds available worker and streams OpenAI chunks', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindWorker = workersModel.findFirstAvailableByModel;
    const originalMarkBusy = workersModel.markBusy;
    const originalMarkAvailable = workersModel.markAvailable;
    const originalCreateReceipt = ordersModel.createReceipt;

    const calls = { enqueued: [], cancelled: [], markBusy: [], markAvailable: [], receipts: [] };

    usersModel.getByApiKey = async (apiKey) => {
        assert.equal(apiKey, 'requester-api-key');
        return { id: 'requester-1' };
    };

    workersModel.findFirstAvailableByModel = async (model) => ({
        id: 'worker-1',
        userId: 'worker-owner-1',
        model,
        tps: 25,
        price: 4
    });

    workersModel.markBusy = async (workerId) => {
        calls.markBusy.push(workerId);
        return true;
    };

    workersModel.markAvailable = async (workerId) => {
        calls.markAvailable.push(workerId);
    };

    ordersModel.createReceipt = async (requesterId, data) => {
        calls.receipts.push({ requesterId, ...data });
        return { id: 99, requesterId, ...data, status: 'running' };
    };

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue(job) {
                calls.enqueued.push(job);
                return 'job-openai-1';
            },
            cancel(jobId) {
                calls.cancelled.push(jobId);
            }
        }
    });

    const handler = getPostHandler(router, '/chat/completions');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: {
            model: 'gpt-4.1-mini',
            stream: true,
            messages: [
                { role: 'system', content: 'Be concise' },
                { role: 'user', content: 'Hello world' }
            ]
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    workersModel.findFirstAvailableByModel = originalFindWorker;
    workersModel.markBusy = originalMarkBusy;
    workersModel.markAvailable = originalMarkAvailable;
    ordersModel.createReceipt = originalCreateReceipt;

    assert.equal(errors.length, 0);
    assert.deepEqual(calls.markBusy, ['worker-1']);
    assert.equal(calls.receipts.length, 1);
    assert.deepEqual(calls.receipts[0], {
        requesterId: 'requester-1',
        workerId: 'worker-1',
        model: 'gpt-4.1-mini',
        price: 4
    });
    assert.equal(calls.enqueued.length, 1);
    assert.equal(calls.enqueued[0].targetWorkerId, 'worker-1');
    assert.deepEqual(calls.enqueued[0].settlement, { orderId: 99, requesterId: 'requester-1' });
    assert.equal(calls.enqueued[0].payload.message, '[system] Be concise\n[user] Hello world');

    calls.enqueued[0].stream.event('message').send('Hi from worker');
    calls.enqueued[0].stream.event('end').send('done');

    assert.equal(res._headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(res._flushed, true);

    const raw = res._written.join('');
    assert.ok(raw.includes('"object":"chat.completion.chunk"'));
    assert.ok(raw.includes('"delta":{"role":"assistant"}'));
    assert.ok(raw.includes('"delta":{"content":"Hi from worker"}'));
    assert.ok(raw.includes('"finish_reason":"stop"'));
    assert.ok(raw.includes('data: [DONE]'));

    res.emitClose();
    assert.deepEqual(calls.cancelled, ['job-openai-1']);
});

test('openAiRouterFactory /chat/completions returns 409 when no available worker found', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindWorker = workersModel.findFirstAvailableByModel;

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    workersModel.findFirstAvailableByModel = async () => null;

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue() { throw new Error('enqueue should not be called'); },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/chat/completions');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: { model: 'gpt-4.1-mini', stream: true, messages: [{ role: 'user', content: 'Ping' }] }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    workersModel.findFirstAvailableByModel = originalFindWorker;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 409);
});

test('openAiRouterFactory /chat/completions returns 503 when markBusy race is lost', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindWorker = workersModel.findFirstAvailableByModel;
    const originalMarkBusy = workersModel.markBusy;

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    workersModel.findFirstAvailableByModel = async () => ({ id: 'worker-1', userId: 'owner-1', model: 'gpt-4.1-mini', tps: 25, price: 4 });
    workersModel.markBusy = async () => false;  // race lost

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue() { throw new Error('enqueue should not be called'); },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/chat/completions');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: { model: 'gpt-4.1-mini', stream: true, messages: [{ role: 'user', content: 'Ping' }] }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    workersModel.findFirstAvailableByModel = originalFindWorker;
    workersModel.markBusy = originalMarkBusy;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 503);
});

test('openAiRouterFactory /chat/completions releases worker and fails receipt if enqueue throws', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindWorker = workersModel.findFirstAvailableByModel;
    const originalMarkBusy = workersModel.markBusy;
    const originalMarkAvailable = workersModel.markAvailable;
    const originalCreateReceipt = ordersModel.createReceipt;
    const originalFailReceipt = ordersModel.failReceipt;

    const cleanupCalls = { markAvailable: [], failReceipt: [] };

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    workersModel.findFirstAvailableByModel = async () => ({ id: 'worker-1', userId: 'owner-1', model: 'gpt-4.1-mini', tps: 25, price: 4 });
    workersModel.markBusy = async () => true;
    workersModel.markAvailable = async (workerId) => { cleanupCalls.markAvailable.push(workerId); };
    ordersModel.createReceipt = async (requesterId, data) => ({ id: 88, requesterId, ...data, status: 'running' });
    ordersModel.failReceipt = async (orderId) => { cleanupCalls.failReceipt.push(orderId); };

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue() {
                const error = new Error('enqueue failed');
                error.status = 503;
                throw error;
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/chat/completions');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: { model: 'gpt-4.1-mini', stream: true, messages: [{ role: 'user', content: 'Ping' }] }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    // Let async fire-and-forget cleanup run
    await new Promise((r) => setImmediate(r));

    usersModel.getByApiKey = originalGetByApiKey;
    workersModel.findFirstAvailableByModel = originalFindWorker;
    workersModel.markBusy = originalMarkBusy;
    workersModel.markAvailable = originalMarkAvailable;
    ordersModel.createReceipt = originalCreateReceipt;
    ordersModel.failReceipt = originalFailReceipt;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 503);
    assert.deepEqual(cleanupCalls.markAvailable, ['worker-1']);
    assert.deepEqual(cleanupCalls.failReceipt, [88]);
});

test('openAiRouterFactory /responses finds available worker and streams response events', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindWorker = workersModel.findFirstAvailableByModel;
    const originalMarkBusy = workersModel.markBusy;
    const originalCreateReceipt = ordersModel.createReceipt;

    const calls = { enqueued: [], cancelled: [] };

    usersModel.getByApiKey = async (apiKey) => {
        assert.equal(apiKey, 'requester-api-key');
        return { id: 'requester-2' };
    };

    workersModel.findFirstAvailableByModel = async (model) => ({
        id: 'worker-2',
        userId: 'worker-owner-2',
        model,
        tps: 30,
        price: 3
    });

    workersModel.markBusy = async () => true;

    ordersModel.createReceipt = async () => ({ id: 100 });

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue(job) {
                calls.enqueued.push(job);
                return 'job-openai-responses-1';
            },
            cancel(jobId) {
                calls.cancelled.push(jobId);
            }
        }
    });

    const handler = getPostHandler(router, '/responses');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: {
            model: 'gpt-4.1-mini',
            stream: true,
            input: [
                { role: 'system', content: [{ type: 'text', text: 'Keep answers short.' }] },
                { role: 'user', content: [{ type: 'text', text: 'Say hello' }] }
            ]
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    workersModel.findFirstAvailableByModel = originalFindWorker;
    workersModel.markBusy = originalMarkBusy;
    ordersModel.createReceipt = originalCreateReceipt;

    assert.equal(errors.length, 0);
    assert.equal(calls.enqueued.length, 1);
    assert.equal(calls.enqueued[0].payload.message, '[system] Keep answers short.\n[user] Say hello');

    calls.enqueued[0].stream.event('message').send('Hello!');
    calls.enqueued[0].stream.event('end').send('done');

    const raw = res._written.join('');
    assert.ok(raw.includes('event: response.created'));
    assert.ok(raw.includes('event: response.output_text.delta'));
    assert.ok(raw.includes('"delta":"Hello!"'));
    assert.ok(raw.includes('event: response.completed'));
    assert.ok(raw.includes('data: [DONE]'));

    res.emitClose();
    assert.deepEqual(calls.cancelled, ['job-openai-responses-1']);
});

test('openAiRouterFactory /responses validates non-empty input', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;

    usersModel.getByApiKey = async () => ({ id: 'requester-2' });

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue() { throw new Error('enqueue should not be called'); },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/responses');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: { model: 'gpt-4.1-mini', stream: true, input: [] }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 400);
});
