import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamRouter } from '../../routes/stream.js';

function makeMockRes() {
    const written = [];
    let headersSent = false;

    return {
        get headersSent() { return headersSent; },
        status() { return this; },
        setHeader() { return this; },
        flushHeaders() { headersSent = true; return this; },
        write(chunk) { written.push(chunk); },
        end() {},
        once() {},
        _written: written
    };
}

function getPostHandler(router, path) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer, `Expected route ${path} to exist`);
    assert.ok(layer.route.methods.post, `Expected route ${path} to support POST`);
    return layer.route.stack[0].handle;
}

test('createStreamRouter /stream without orderId uses legacy mode and does not resolve orders model', async () => {
    let resolveOrdersModelCalls = 0;
    const enqueued = [];

    const router = createStreamRouter({
        resolveOrdersModel: () => {
            resolveOrdersModelCalls += 1;
            return {};
        },
        streamRouter: {
            enqueue(job) {
                enqueued.push(job);
                return 'legacy-job-id';
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/stream');

    const req = { body: { message: 'hello', model: 'llama3' } };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await handler(req, res, next);

    assert.equal(errors.length, 0);
    assert.equal(resolveOrdersModelCalls, 0, 'legacy mode must not resolve orders model');
    assert.equal(enqueued.length, 1, 'legacy stream must enqueue a single job');
    assert.equal(enqueued[0].targetWorkerId, undefined, 'legacy mode must not target a worker');
});

test('createStreamRouter /stream with orderId uses order consume mode', async () => {
    let resolveOrdersModelCalls = 0;
    let consumeCalls = 0;
    const enqueued = [];

    const ordersModel = {
        async consumeForUse(consumerId, orderId) {
            consumeCalls += 1;
            assert.equal(consumerId, 'consumer-stream');
            assert.equal(orderId, 11);
            return {
                status: 'consumed',
                order: { id: 11, workerId: 'worker-11', model: 'gpt-oss' },
                consumer: { id: 1, credits: 10 }
            };
        },
        async unconsumForUse() {}
    };

    const router = createStreamRouter({
        resolveOrdersModel: () => {
            resolveOrdersModelCalls += 1;
            return ordersModel;
        },
        streamRouter: {
            enqueue(job) {
                enqueued.push(job);
                return 'targeted-job-id';
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/stream');

    const req = {
        headers: { 'x-user-id': 'consumer-stream' },
        body: { orderId: '11', message: 'route dispatch' }
    };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await handler(req, res, next);

    assert.equal(errors.length, 0);
    assert.equal(resolveOrdersModelCalls, 1, 'order mode must resolve orders model once');
    assert.equal(consumeCalls, 1, 'order mode must consume order once');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].targetWorkerId, 'worker-11');
});

test('createStreamRouter /workers/:orderid/use preserves param-based order consume flow', async () => {
    let consumedOrderId = null;
    const enqueued = [];

    const router = createStreamRouter({
        resolveOrdersModel: () => ({
            async consumeForUse(_, orderId) {
                consumedOrderId = orderId;
                return {
                    status: 'consumed',
                    order: { id: orderId, workerId: 'worker-param', model: 'llama' },
                    consumer: { id: 2, credits: 5 }
                };
            },
            async unconsumForUse() {}
        }),
        streamRouter: {
            enqueue(job) {
                enqueued.push(job);
                return 'param-job-id';
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/workers/:orderid/use');

    const req = {
        params: { orderid: '29' },
        headers: { 'x-user-id': 'consumer-param' },
        body: { message: 'from param route' }
    };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await handler(req, res, next);

    assert.equal(errors.length, 0);
    assert.equal(consumedOrderId, 29, 'order id must come from :orderid route param');
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].targetWorkerId, 'worker-param');
});