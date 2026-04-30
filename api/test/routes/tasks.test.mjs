import test from 'node:test';
import assert from 'node:assert/strict';

import { tasksRouterFactory } from '../../routes/tasks.js';

function makeMockRes() {
    let headersSent = false;
    let writableEnded = false;

    return {
        get headersSent() { return headersSent; },
        get writableEnded() { return writableEnded; },
        status() { return this; },
        setHeader() { return this; },
        flushHeaders() { headersSent = true; return this; },
        write() { return true; },
        end() { writableEnded = true; },
        once() {}
    };
}

function getPostHandler(router, path) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer, `Expected route ${path} to exist`);
    assert.ok(layer.route.methods.post, `Expected route ${path} to support POST`);
    return layer.route.stack[0].handle;
}

test('tasksRouterFactory does not expose deprecated /:orderid/run endpoint', () => {
    const router = tasksRouterFactory({
        streamRouter: {
            enqueue() {
                return 'job-1';
            },
            cancel() {}
        }
    });

    const legacyLayer = router.stack.find((candidate) => candidate.route?.path === '/:orderid/run');
    assert.equal(legacyLayer, undefined);
});

test('tasksRouterFactory /run enqueues model-based stream job', async () => {
    const enqueued = [];

    const router = tasksRouterFactory({
        streamRouter: {
            enqueue(job) {
                enqueued.push(job);
                return 'job-1';
            },
            cancel() {}
        }
    });

    const handler = getPostHandler(router, '/run');
    const req = {
        body: {
            model: 'gpt-oss',
            input: 'run this'
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => {
        errors.push(error);
    });

    assert.equal(errors.length, 0);
    assert.equal(enqueued.length, 1);
    assert.deepEqual(enqueued[0].payload, {
        message: 'run this',
        model: 'gpt-oss'
    });
});
