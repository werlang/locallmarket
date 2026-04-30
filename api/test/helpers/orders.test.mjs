import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyLegacyStream,
    applyOrderUseStream,
    parseCreateOrderBody,
    parseLegacyStreamBody,
    parseListOrdersQuery,
    parseOrderId,
    parseOwnerIdHeader,
    parseUseWorkerBody,
    parseUpdateOrderBody
} from '../../helpers/orders.js';

test('parseOwnerIdHeader requires x-user-id header', () => {
    assert.equal(
        parseOwnerIdHeader({ 'x-user-id': ' user-1 ' }),
        'user-1'
    );

    assert.throws(
        () => parseOwnerIdHeader({}),
        /x-user-id header is required/
    );
});

test('parseCreateOrderBody validates required fields', () => {
    const payload = parseCreateOrderBody({
        workerId: ' worker-1 ',
        model: ' llama3 ',
        price: '1.25',
        tps: '30'
    });

    assert.deepEqual(payload, {
        workerId: 'worker-1',
        model: 'llama3',
        price: 1.25,
        tps: 30,
        isAvailable: true
    });

    assert.throws(() => parseCreateOrderBody({ workerId: 'w', model: 'm', price: 0, tps: 1 }), /price must be a positive number/);
    assert.throws(() => parseCreateOrderBody({ workerId: 'w', model: 'm', price: 1, tps: 0 }), /tps must be a positive integer/);
});

test('parseUpdateOrderBody requires at least one field and validates booleans', () => {
    assert.throws(() => parseUpdateOrderBody({}), /At least one field must be provided/);

    const payload = parseUpdateOrderBody({ isAvailable: 'false', tps: '50' });
    assert.deepEqual(payload, { isAvailable: false, tps: 50 });
});

test('parseOrderId validates path param', () => {
    assert.equal(parseOrderId('22'), 22);
    assert.throws(() => parseOrderId('0'), /orderId must be a positive integer/);
});

test('parseListOrdersQuery parses filters and ranges', () => {
    assert.deepEqual(parseListOrdersQuery({}), {
        onlyAvailable: false,
        limit: 100,
        offset: 0
    });

    assert.deepEqual(
        parseListOrdersQuery({
            model: ' gpt-oss ',
            minPrice: '0.3',
            maxPrice: '3.1',
            minTps: '10',
            maxTps: '80',
            onlyAvailable: 'true',
            limit: '10',
            offset: '5'
        }),
        {
            model: 'gpt-oss',
            minPrice: 0.3,
            maxPrice: 3.1,
            minTps: 10,
            maxTps: 80,
            onlyAvailable: true,
            limit: 10,
            offset: 5
        }
    );

    assert.throws(() => parseListOrdersQuery({ minPrice: 4, maxPrice: 2 }), /minPrice cannot be greater than maxPrice/);
    assert.throws(() => parseListOrdersQuery({ minTps: 20, maxTps: 10 }), /minTps cannot be greater than maxTps/);
});

test('parseUseWorkerBody supports message and legacy input aliases', () => {
    assert.deepEqual(parseUseWorkerBody({ message: ' hi ' }), { message: 'hi' });
    assert.deepEqual(parseUseWorkerBody({ input: ' hello ' }), { message: 'hello' });

    assert.throws(() => parseUseWorkerBody({}), /message must be a non-empty string/);
});

test('parseLegacyStreamBody keeps legacy /stream payload semantics', () => {
    assert.deepEqual(parseLegacyStreamBody({ message: ' hi ', model: ' llama3 ' }), {
        message: 'hi',
        model: 'llama3'
    });

    assert.deepEqual(parseLegacyStreamBody({ input: ' hello ', model: ' gpt-oss ' }), {
        message: 'hello',
        model: 'gpt-oss'
    });

    assert.throws(() => parseLegacyStreamBody({ message: 'hi' }), /model is required in the request body/);
});

// ---------------------------------------------------------------------------
// applyOrderUseStream – route-level behavior
// ---------------------------------------------------------------------------

/**
 * Minimal mock Express response that captures SSE headers and written chunks.
 */
function makeMockRes() {
    const written = [];
    let statusCode = null;
    let headersSent = false;
    const listeners = {};

    const res = {
        get headersSent() { return headersSent; },
        status(code) { statusCode = code; return res; },
        setHeader() { return res; },
        flushHeaders() { headersSent = true; return res; },
        write(chunk) { written.push(chunk); },
        end() {},
        once(event, cb) { listeners[event] = cb; },
        // Test helpers
        _written: written,
        _getStatus: () => statusCode
    };
    return res;
}

test('applyOrderUseStream opens SSE stream and enqueues targeted job on successful consume', async () => {
    const consumedResult = {
        status: 'consumed',
        order: { id: 1, workerId: 'w-1', model: 'llama' },
        consumer: { id: 9, credits: 5 }
    };

    const enqueuedJobs = [];
    const mockOrdersModel = {
        async consumeForUse() { return consumedResult; }
    };
    const mockStreamRouter = {
        enqueue(job) { enqueuedJobs.push(job); return 'job-uuid-1'; },
        cancel() {}
    };

    const req = { headers: { 'x-user-id': 'consumer-1' }, body: { message: 'hello' } };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await applyOrderUseStream({
        req, res, next,
        orderIdRaw: '42',
        ordersModel: mockOrdersModel,
        streamRouter: mockStreamRouter
    });

    assert.equal(errors.length, 0, 'no error should have been passed to next()');
    assert.equal(enqueuedJobs.length, 1, 'one job must be enqueued');
    assert.equal(enqueuedJobs[0].payload.message, 'hello');
    assert.equal(enqueuedJobs[0].payload.model, 'llama');
    assert.equal(enqueuedJobs[0].targetWorkerId, 'w-1');
    assert.equal(typeof enqueuedJobs[0].onJobAborted, 'function', 'onJobAborted callback must be provided');
    assert.ok(res.headersSent, 'SSE headers must be flushed after successful consume');
});

test('applyOrderUseStream legacy /stream route: orderId sourced from body', async () => {
    const consumedResult = {
        status: 'consumed',
        order: { id: 7, workerId: 'w-legacy', model: 'gpt-oss' },
        consumer: { id: 3, credits: 10 }
    };

    const enqueuedJobs = [];
    const mockOrdersModel = {
        async consumeForUse(_, orderId) {
            assert.equal(orderId, 7, 'orderId must be parsed from body for legacy /stream');
            return consumedResult;
        }
    };
    const mockStreamRouter = {
        enqueue(job) { enqueuedJobs.push(job); return 'job-uuid-2'; },
        cancel() {}
    };

    const req = { headers: { 'x-user-id': 'consumer-2' }, body: { orderId: '7', message: 'query' } };
    const res = makeMockRes();
    const next = () => {};

    // Legacy route passes orderId from body as orderIdRaw
    await applyOrderUseStream({
        req, res, next,
        orderIdRaw: req.body.orderId,
        ordersModel: mockOrdersModel,
        streamRouter: mockStreamRouter
    });

    assert.equal(enqueuedJobs.length, 1);
    assert.equal(enqueuedJobs[0].targetWorkerId, 'w-legacy');
});

test('applyOrderUseStream compensation: onJobAborted reverses consume and signals error on stream', async () => {
    let unconsumCalled = false;
    const consumedResult = {
        status: 'consumed',
        order: { id: 5, workerId: 'w-abort', model: 'llama' },
        consumer: { id: 2, credits: 0 }
    };

    const mockOrdersModel = {
        async consumeForUse() { return consumedResult; },
        async unconsumForUse(consumerId, orderId) {
            assert.equal(consumerId, 'consumer-3');
            assert.equal(orderId, 5);
            unconsumCalled = true;
        }
    };

    let capturedAbort = null;
    const mockStreamRouter = {
        enqueue(job) { capturedAbort = job.onJobAborted; return 'job-uuid-3'; },
        cancel() {}
    };

    const req = { headers: { 'x-user-id': 'consumer-3' }, body: { message: 'test' } };
    const res = makeMockRes();
    const next = () => {};

    await applyOrderUseStream({
        req, res, next,
        orderIdRaw: '5',
        ordersModel: mockOrdersModel,
        streamRouter: mockStreamRouter
    });

    assert.equal(typeof capturedAbort, 'function');

    // Simulate abort callback fired by StreamRouter (worker disconnect while queued)
    await capturedAbort();

    assert.equal(unconsumCalled, true, 'unconsumForUse must be called when job is aborted');
    // Stream should be closed after abort
    assert.ok(res._written.some((chunk) => chunk.includes('error')), 'error event must be written to SSE stream');
});

test('applyOrderUseStream passes error to next() when consume fails before headers sent', async () => {
    const mockOrdersModel = {
        async consumeForUse() { throw { status: 409, message: 'Order already consumed.' }; }
    };
    const mockStreamRouter = { enqueue() {}, cancel() {} };

    const req = { headers: { 'x-user-id': 'consumer-4' }, body: { message: 'hi' } };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await applyOrderUseStream({
        req, res, next,
        orderIdRaw: '10',
        ordersModel: mockOrdersModel,
        streamRouter: mockStreamRouter
    });

    assert.equal(errors.length, 1, 'error must be forwarded to next() when headers are not yet sent');
    assert.ok(!res.headersSent, 'headers must not be flushed when consume fails');
});

test('applyLegacyStream enqueues untargeted model-based job for compatibility mode', async () => {
    const enqueuedJobs = [];
    const mockStreamRouter = {
        enqueue(job) { enqueuedJobs.push(job); return 'job-legacy-1'; },
        cancel() {}
    };

    const req = { body: { input: 'legacy query', model: 'llama3' } };
    const res = makeMockRes();
    const errors = [];
    const next = (err) => errors.push(err);

    await applyLegacyStream({
        req,
        res,
        next,
        streamRouter: mockStreamRouter
    });

    assert.equal(errors.length, 0);
    assert.equal(enqueuedJobs.length, 1);
    assert.deepEqual(enqueuedJobs[0].payload, {
        message: 'legacy query',
        model: 'llama3'
    });
    assert.equal(enqueuedJobs[0].targetWorkerId, undefined);
    assert.ok(res.headersSent, 'SSE headers must be flushed for legacy stream mode');
});

