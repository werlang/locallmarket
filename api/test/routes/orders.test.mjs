import test from 'node:test';
import assert from 'node:assert/strict';

import { router as ordersRouter } from '../../routes/orders.js';
import { ordersModel } from '../../models/orders.js';
import { usersModel } from '../../models/users.js';

function getRouteHandler(router, method, path) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route?.methods?.[method]);
    assert.ok(layer, `Expected route ${path} to exist`);
    assert.ok(layer.route.methods[method], `Expected route ${path} to support ${method.toUpperCase()}`);
    return layer.route.stack[0].handle;
}

function makeMockRes() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.payload = data;
            return this;
        }
    };
}

test('ordersRouter GET / lists authenticated requester receipts', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalListOwn = ordersModel.listOwn;

    usersModel.getByApiKey = async () => ({ id: 'requester-1' });
    ordersModel.listOwn = async (requesterId) => {
        assert.equal(requesterId, 'requester-1');
        return [{ id: 11, requesterId: 'requester-1', workerId: 'worker-1', model: 'llama3', price: 1.5, status: 'completed' }];
    };

    const handler = getRouteHandler(ordersRouter, 'get', '/');
    const req = { headers: { authorization: 'Bearer requester-api-key' } };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.listOwn = originalListOwn;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
        ok: true,
        orders: [{ id: 11, requesterId: 'requester-1', workerId: 'worker-1', model: 'llama3', price: 1.5, status: 'completed' }]
    });
});

test('ordersRouter GET / does not expose GET /public route', () => {
    const layer = ordersRouter.stack.find((c) => c.route?.path === '/public');
    assert.equal(layer, undefined, 'GET /public should not exist on orders router');
});

test('ordersRouter does not expose POST / route', () => {
    const layer = ordersRouter.stack.find((c) => c.route?.path === '/' && c.route?.methods?.post);
    assert.equal(layer, undefined, 'POST / should not exist on orders router');
});
