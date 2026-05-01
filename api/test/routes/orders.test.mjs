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

test('ordersRouter GET / lists authenticated owner orders', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalListOwn = ordersModel.listOwn;

    usersModel.getByApiKey = async () => ({ id: 'owner-1' });
    ordersModel.listOwn = async (ownerId) => {
        assert.equal(ownerId, 'owner-1');
        return [{ id: 11, userId: 'owner-1', workerId: 'worker-1' }];
    };

    const handler = getRouteHandler(ordersRouter, 'get', '/');
    const req = { headers: { authorization: 'Bearer owner-api-key' } };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.listOwn = originalListOwn;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
        ok: true,
        orders: [{ id: 11, userId: 'owner-1', workerId: 'worker-1' }]
    });
});

test('ordersRouter GET /public lists marketplace offers without auth', async () => {
    const originalListPublic = ordersModel.listPublic;

    ordersModel.listPublic = async () => {
        return [{ id: 91, workerId: 'worker-3', model: 'gpt-oss', price: 1.8, tps: 42 }];
    };

    const handler = getRouteHandler(ordersRouter, 'get', '/public');
    const req = { headers: {} };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    ordersModel.listPublic = originalListPublic;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
        ok: true,
        orders: [{ id: 91, workerId: 'worker-3', model: 'gpt-oss', price: 1.8, tps: 42 }]
    });
});

test('ordersRouter POST / creates owner offer binding', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalCreateOwnOffer = ordersModel.createOwnOffer;

    usersModel.getByApiKey = async () => ({ id: 'owner-1' });
    ordersModel.createOwnOffer = async (ownerId, payload) => {
        assert.equal(ownerId, 'owner-1');
        assert.deepEqual(payload, {
            workerId: 'worker-1',
            model: 'gpt-oss',
            price: 1.25,
            tps: 35
        });
        return { id: 12, userId: ownerId, ...payload, isAvailable: true, isConsumed: false };
    };

    const handler = getRouteHandler(ordersRouter, 'post', '/');
    const req = {
        headers: { authorization: 'Bearer owner-api-key' },
        body: { workerId: 'worker-1', model: 'gpt-oss', price: 1.25, tps: 35 }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.createOwnOffer = originalCreateOwnOffer;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.order.id, 12);
});

test('ordersRouter PUT /:orderId updates owner order binding', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalUpdateOwn = ordersModel.updateOwn;

    usersModel.getByApiKey = async () => ({ id: 'owner-1' });
    ordersModel.updateOwn = async (ownerId, orderId, payload) => {
        assert.equal(ownerId, 'owner-1');
        assert.equal(orderId, 12);
        assert.deepEqual(payload, { price: 2.5, tps: 40 });
        return { id: 12, userId: ownerId, workerId: 'worker-1', model: 'gpt-oss', price: 2.5, tps: 40 };
    };

    const handler = getRouteHandler(ordersRouter, 'put', '/:orderId');
    const req = {
        headers: { authorization: 'Bearer owner-api-key' },
        params: { orderId: '12' },
        body: { price: 2.5, tps: 40 }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.updateOwn = originalUpdateOwn;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.order.price, 2.5);
});

test('ordersRouter DELETE /:orderId deletes owner order', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalDeleteOwn = ordersModel.deleteOwn;

    usersModel.getByApiKey = async () => ({ id: 'owner-1' });
    ordersModel.deleteOwn = async (ownerId, orderId) => {
        assert.equal(ownerId, 'owner-1');
        assert.equal(orderId, 15);
    };

    const handler = getRouteHandler(ordersRouter, 'delete', '/:orderId');
    const req = {
        headers: { authorization: 'Bearer owner-api-key' },
        params: { orderId: '15' }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.deleteOwn = originalDeleteOwn;

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, { ok: true });
});

test('ordersRouter enable/disable routes toggle owner order availability', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const originalSetOwnAvailability = ordersModel.setOwnAvailability;
    const calls = [];

    usersModel.getByApiKey = async () => ({ id: 'owner-1' });
    ordersModel.setOwnAvailability = async (ownerId, orderId, enabled) => {
        calls.push({ ownerId, orderId, enabled });
        return { id: orderId, userId: ownerId, isAvailable: enabled };
    };

    const enableHandler = getRouteHandler(ordersRouter, 'post', '/:orderId/enable');
    const disableHandler = getRouteHandler(ordersRouter, 'post', '/:orderId/disable');

    const enableRes = makeMockRes();
    const disableRes = makeMockRes();
    const errors = [];

    await enableHandler({ headers: { authorization: 'Bearer owner-api-key' }, params: { orderId: '20' } }, enableRes, (error) => errors.push(error));
    await disableHandler({ headers: { authorization: 'Bearer owner-api-key' }, params: { orderId: '20' } }, disableRes, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;
    ordersModel.setOwnAvailability = originalSetOwnAvailability;

    assert.equal(errors.length, 0);
    assert.deepEqual(calls, [
        { ownerId: 'owner-1', orderId: 20, enabled: true },
        { ownerId: 'owner-1', orderId: 20, enabled: false }
    ]);
    assert.equal(enableRes.payload.order.isAvailable, true);
    assert.equal(disableRes.payload.order.isAvailable, false);
});
