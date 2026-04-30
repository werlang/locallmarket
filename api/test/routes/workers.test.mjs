import test from 'node:test';
import assert from 'node:assert/strict';

import { workersRouterFactory } from '../../routes/workers.js';
import { usersModel } from '../../models/users.js';

function getGetHandler(router, path) {
    const layer = router.stack.find((candidate) => candidate.route?.path === path);
    assert.ok(layer, `Expected route ${path} to exist`);
    assert.ok(layer.route.methods.get, `Expected route ${path} to support GET`);
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

test('workersRouterFactory GET /pool returns owner-scoped worker pool details', async () => {
    const originalGetByApiKey = usersModel.getByApiKey;
    const workersModelCalls = [];
    const snapshotCalls = [];

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
                        userId: ownerId,
                        status: 'connected',
                        connected: true,
                        available: true,
                        activeJobId: null,
                        model: 'gpt-oss',
                        price: 2.5,
                        tps: 42,
                        offerId: 101,
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
                snapshotCalls.push(options);
                return [{ id: 'worker-1', connected: true, available: true, activeJobId: null }];
            }
        }
    });

    const handler = getGetHandler(router, '/pool');
    const req = {
        headers: {
            authorization: 'Bearer owner-api-key'
        }
    };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => {
        errors.push(error);
    });

    usersModel.getByApiKey = originalGetByApiKey;

    assert.equal(errors.length, 0);
    assert.deepEqual(snapshotCalls, [{ ownerId: 'owner-1' }]);
    assert.equal(workersModelCalls.length, 1);
    assert.equal(workersModelCalls[0].ownerId, 'owner-1');
    assert.deepEqual(workersModelCalls[0].options.runtimeWorkers, [
        { id: 'worker-1', connected: true, available: true, activeJobId: null }
    ]);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload, {
        ok: true,
        workers: [
            {
                id: 'worker-1',
                userId: 'owner-1',
                status: 'connected',
                connected: true,
                available: true,
                activeJobId: null,
                model: 'gpt-oss',
                price: 2.5,
                tps: 42,
                offerId: 101,
                connectedAt: '2026-04-30T10:00:00.000Z',
                disconnectedAt: null,
                lastSeenAt: '2026-04-30T10:01:00.000Z',
                createdAt: '2026-04-30T09:00:00.000Z',
                updatedAt: '2026-04-30T10:01:00.000Z'
            }
        ]
    });
});

test('workersRouterFactory GET /pool forwards auth failures to next', async () => {
    const router = workersRouterFactory({
        workersModel: {
            async listPoolByOwner() {
                throw new Error('listPoolByOwner should not be called');
            }
        },
        streamRouter: {
            getWorkersSnapshot() {
                return [];
            }
        }
    });

    const handler = getGetHandler(router, '/pool');
    const req = { headers: {} };
    const res = makeMockRes();
    const errors = [];

    await handler(req, res, (error) => {
        errors.push(error);
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].status, 401);
});
