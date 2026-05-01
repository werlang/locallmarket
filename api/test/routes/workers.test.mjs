import test from 'node:test';
import assert from 'node:assert/strict';

import { workersRouterFactory } from '../../routes/workers.js';
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

test('workersRouterFactory GET / returns owner-scoped worker pool', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const workersModelCalls = [];

    usersModel.getByApiKey = async (apiKey) => {
        assert.equal(apiKey, 'owner-api-key');
        return { id: 'owner-1' };
    };

    const router = workersRouterFactory({
        workersModel: {
            async listPoolByOwner(ownerId, options) {
                workersModelCalls.push({ ownerId, options });
                return [
                    {
                        id: 'worker-1',
                        userId: 'owner-1',
                        model: 'llama3',
                        tps: 42,
                        price: 2.5,
                        status: 'available',
                        connected: true,
                        available: true,
                        activeJobId: null,
                        connectedAt: '2026-04-30T10:00:00.000Z',
                        disconnectedAt: null,
                        lastSeenAt: '2026-04-30T10:01:00.000Z',
                        createdAt: '2026-04-30T09:00:00.000Z',
                        updatedAt: '2026-04-30T10:01:00.000Z'
                    }
                ];
            }
        },
        streamRouter: {
            getWorkersSnapshot(options) {
                return [{ id: 'worker-1', connected: true, available: true, activeJobId: null }];
            }
        }
    });

    const handler = getRouteHandler(router, 'get', '/');
    const req = { headers: { authorization: 'Bearer owner-api-key' } };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    usersModel.getByApiKey = originalGetByApiKey;

    assert.equal(errors.length, 0);
    assert.equal(workersModelCalls.length, 1);
    assert.equal(workersModelCalls[0].ownerId, 'owner-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.workers.length, 1);
    assert.equal(res.payload.workers[0].id, 'worker-1');
});

test('workersRouterFactory GET / forwards auth failures to next', async () => {
    const router = workersRouterFactory({
        workersModel: {
            async listPoolByOwner() {
                throw new Error('should not be called');
            }
        },
        streamRouter: {
            getWorkersSnapshot() {
                return [];
            }
        }
    });

    const handler = getRouteHandler(router, 'get', '/');
    const req = { headers: {} };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 401);
});

test('workersRouterFactory GET /public lists available workers without auth', async () => {
    const router = workersRouterFactory({
        workersModel: {
            async listPublic() {
                return [
                    { id: 'worker-1', model: 'llama3', tps: 42, price: 2.5, status: 'available' }
                ];
            }
        },
        streamRouter: {}
    });

    const handler = getRouteHandler(router, 'get', '/public');
    const req = { headers: {} };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => errors.push(error));

    assert.equal(errors.length, 0);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
        ok: true,
        workers: [{ id: 'worker-1', model: 'llama3', tps: 42, price: 2.5, status: 'available' }]
    });
});
