import test from 'node:test';
import assert from 'node:assert/strict';

import { openAiRouterFactory } from '../../routes/openai.js';
import { ordersModel } from '../../models/orders.js';
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

test('openAiRouterFactory /chat/completions auto-matches and consumes existing offer, then streams OpenAI chunks', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindOffer = ordersModel.findFirstAvailableOfferByModel;
    const originalConsumeForUse = ordersModel.consumeForUse;
    const originalUnconsumeForUse = ordersModel.unconsumForUse;

    const calls = {
        models: [],
        consume: [],
        enqueued: [],
        cancelled: []
    };

    usersModel.getByApiKey = async (apiKey) => {
        assert.equal(apiKey, 'requester-api-key');
        return { id: 'requester-1' };
    };

    ordersModel.findFirstAvailableOfferByModel = async (model) => {
        calls.models.push(model);
        return {
            id: 9,
            userId: 'worker-owner-1',
            workerId: 'worker-1',
            model,
            price: 4,
            tps: 25
        };
    };

    ordersModel.consumeForUse = async (consumerId, orderId) => {
        calls.consume.push({ consumerId, orderId });
        return {
            status: 'consumed',
            order: {
                id: orderId,
                workerId: 'worker-1',
                model: 'gpt-4.1-mini'
            }
        };
    };

    ordersModel.unconsumForUse = async () => {
        throw new Error('unconsumForUse should not be called on success path');
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

    await handler(req, res, (error) => {
        errors.push(error);
    });

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.findFirstAvailableOfferByModel = originalFindOffer;
    ordersModel.consumeForUse = originalConsumeForUse;
    ordersModel.unconsumForUse = originalUnconsumeForUse;

    assert.equal(errors.length, 0);
    assert.deepEqual(calls.models, ['gpt-4.1-mini']);
    assert.equal(calls.consume.length, 1);
    assert.deepEqual(calls.consume[0], { consumerId: 'requester-1', orderId: 9 });
    assert.equal(calls.enqueued.length, 1);
    assert.equal(calls.enqueued[0].targetWorkerId, 'worker-1');
    assert.deepEqual(calls.enqueued[0].settlement, {
        orderId: 9,
        requesterId: 'requester-1'
    });
    assert.equal(calls.enqueued[0].payload.message, '[system] Be concise\n[user] Hello world');

    calls.enqueued[0].stream.event('message').send('Hi from worker');
    calls.enqueued[0].stream.event('end').send('done');

    assert.equal(res._headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(res._headers['Cache-Control'], 'no-cache, no-transform');
    assert.equal(res._headers.Connection, 'keep-alive');
    assert.equal(res._headers['X-Accel-Buffering'], 'no');
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

test('openAiRouterFactory /chat/completions returns 409 when no worker is available for model', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindOffer = ordersModel.findFirstAvailableOfferByModel;

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    ordersModel.findFirstAvailableOfferByModel = async () => null;

    const router = openAiRouterFactory({
        streamRouter: {
            enqueue() {
                throw new Error('enqueue should not be called');
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/chat/completions');
    const req = {
        headers: { authorization: 'Bearer requester-api-key' },
        body: {
            model: 'gpt-4.1-mini',
            stream: true,
            messages: [{ role: 'user', content: 'Ping' }]
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => {
        errors.push(error);
    });

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.findFirstAvailableOfferByModel = originalFindOffer;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 409);
});

test('openAiRouterFactory /chat/completions refunds consumed offer if enqueue fails', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalFindOffer = ordersModel.findFirstAvailableOfferByModel;
    const originalConsumeForUse = ordersModel.consumeForUse;
    const originalUnconsumeForUse = ordersModel.unconsumForUse;

    const cleanupCalls = [];

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    ordersModel.findFirstAvailableOfferByModel = async () => ({
        id: 9,
        userId: 'worker-owner-1',
        workerId: 'worker-1',
        model: 'gpt-4.1-mini',
        price: 4,
        tps: 25
    });
    ordersModel.consumeForUse = async () => {
        return {
            status: 'consumed',
            order: {
                id: 88,
                workerId: 'worker-1',
                model: 'gpt-4.1-mini'
            }
        };
    };
    ordersModel.unconsumForUse = async (ownerId, orderId) => {
        cleanupCalls.push({ ownerId, orderId });
    };

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
        body: {
            model: 'gpt-4.1-mini',
            stream: true,
            messages: [{ role: 'user', content: 'Ping' }]
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => {
        errors.push(error);
    });

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.findFirstAvailableOfferByModel = originalFindOffer;
    ordersModel.consumeForUse = originalConsumeForUse;
    ordersModel.unconsumForUse = originalUnconsumeForUse;

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 503);
    assert.deepEqual(cleanupCalls, [{ ownerId: 'requester-1', orderId: 88 }]);
});
