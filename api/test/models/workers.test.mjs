import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkersModel } from '../../models/workers.js';

function createMysqlStub(overrides = {}) {
    return {
        raw(value) {
            return { toSqlString: () => value };
        },
        async upsert() {
            return undefined;
        },
        async update() {
            return undefined;
        },
        async findOne() {
            return null;
        },
        ...overrides
    };
}

test('bindConnectedWorker rejects an invalid api key before persistence', async () => {
    let lookupCalled = false;
    const model = new WorkersModel({
        mysql: createMysqlStub(),
        users: {
            async getByApiKeyOrNull() {
                lookupCalled = true;
                return null;
            }
        }
    });

    await assert.rejects(
        () => model.bindConnectedWorker({ workerId: 'worker-1', apiKey: 'bad-key' }),
        /Invalid API key/
    );
    assert.equal(lookupCalled, false);
});

test('bindConnectedWorker rejects invalid api key formats deterministically', async () => {
    const invalidApiKeys = [
        '',
        'short',
        'g'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        42,
        null,
        undefined
    ];

    for (const apiKey of invalidApiKeys) {
        const model = new WorkersModel({
            mysql: createMysqlStub(),
            users: {
                async getByApiKeyOrNull() {
                    throw new Error('lookup should not be called for invalid api key formats');
                }
            }
        });

        await assert.rejects(
            () => model.bindConnectedWorker({ workerId: 'worker-1', apiKey }),
            /Invalid API key|apiKey is required/
        );
    }
});

test('bindConnectedWorker rejects rebinding another user\'s worker id', async () => {
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async findOne() {
                return {
                    id: 'worker-1',
                    user_id: 'user-2',
                    status: 'connected',
                    connected_at: '2026-04-30T10:00:00.000Z',
                    disconnected_at: null,
                    last_seen_at: '2026-04-30T10:00:00.000Z',
                    created_at: '2026-04-30T10:00:00.000Z',
                    updated_at: '2026-04-30T10:00:00.000Z'
                };
            }
        }),
        users: {
            async getByApiKeyOrNull() {
                return { id: 'user-1' };
            }
        }
    });

    await assert.rejects(
        () => model.bindConnectedWorker({ workerId: 'worker-1', apiKey: 'a'.repeat(64) }),
        /already belongs to another user/
    );
});

test('bindConnectedWorker persists a connected worker under the resolved owner', async () => {
    const upsertCalls = [];
    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne(table, options) {
            if (options.filter.id === 'worker-1' && upsertCalls.length === 0) {
                return null;
            }

            return {
                id: 'worker-1',
                user_id: 'user-1',
                status: 'connected',
                connected_at: '2026-04-30T10:00:00.000Z',
                disconnected_at: null,
                last_seen_at: '2026-04-30T10:00:00.000Z',
                created_at: '2026-04-30T10:00:00.000Z',
                updated_at: '2026-04-30T10:00:00.000Z'
            };
        }
    });

    const model = new WorkersModel({
        mysql,
        users: {
            async getByApiKeyOrNull(apiKey) {
                assert.equal(apiKey, 'a'.repeat(64));
                return { id: 'user-1' };
            }
        }
    });

    const result = await model.bindConnectedWorker({ workerId: ' worker-1 ', apiKey: 'a'.repeat(64) });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
    assert.equal(upsertCalls[0].data.id, 'worker-1');
    assert.equal(upsertCalls[0].data.user_id, 'user-1');
    assert.equal(upsertCalls[0].data.status, 'connected');
    assert.equal(typeof upsertCalls[0].data.connected_at.toSqlString, 'function');
    assert.equal(result.user.id, 'user-1');
    assert.equal(result.worker.id, 'worker-1');
    assert.equal(result.worker.userId, 'user-1');
});

test('bindConnectedWorker reconnect keeps ownership immutable and only updates lifecycle fields', async () => {
    const upsertCalls = [];
    const existingRow = {
        id: 'worker-immutable',
        user_id: 'user-1',
        status: 'connected',
        connected_at: '2026-04-30T10:00:00.000Z',
        disconnected_at: null,
        last_seen_at: '2026-04-30T10:00:00.000Z',
        created_at: '2026-04-30T10:00:00.000Z',
        updated_at: '2026-04-30T10:00:00.000Z'
    };

    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne() {
            return existingRow;
        }
    });

    const model = new WorkersModel({
        mysql,
        users: {
            async getByApiKeyOrNull() {
                return { id: 'user-1' };
            }
        }
    });

    const result = await model.bindConnectedWorker({ workerId: 'worker-immutable', apiKey: 'a'.repeat(64) });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
    assert.equal(upsertCalls[0].data.user_id, 'user-1');
    assert.deepEqual(upsertCalls[0].options.updateFields, ['status', 'connected_at', 'disconnected_at', 'last_seen_at']);
    assert.equal(upsertCalls[0].options.updateFields.includes('user_id'), false);
    assert.equal(upsertCalls[0].data.status, 'connected');
    assert.equal(typeof upsertCalls[0].data.connected_at.toSqlString, 'function');
    assert.equal(typeof upsertCalls[0].data.last_seen_at.toSqlString, 'function');
    assert.equal(upsertCalls[0].data.disconnected_at, null);
    assert.equal(result.worker.userId, 'user-1');
});

test('bindConnectedWorker rejects if ownership changes during concurrent registration race', async () => {
    let findCalls = 0;
    const upsertCalls = [];

    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne() {
            findCalls += 1;

            if (findCalls === 1) {
                return null;
            }

            return {
                id: 'worker-race',
                user_id: 'user-2',
                status: 'connected',
                connected_at: '2026-04-30T10:00:00.000Z',
                disconnected_at: null,
                last_seen_at: '2026-04-30T10:00:00.000Z',
                created_at: '2026-04-30T10:00:00.000Z',
                updated_at: '2026-04-30T10:00:00.000Z'
            };
        }
    });

    const model = new WorkersModel({
        mysql,
        users: {
            async getByApiKeyOrNull() {
                return { id: 'user-1' };
            }
        }
    });

    await assert.rejects(
        () => model.bindConnectedWorker({ workerId: 'worker-race', apiKey: 'a'.repeat(64) }),
        /already belongs to another user/
    );

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
});

test('markDisconnected persists disconnect timestamps by worker id', async () => {
    const updateCalls = [];
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    await model.markDisconnected(' worker-2 ');

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].table, 'workers');
    assert.deepEqual(updateCalls[0].filter, { id: 'worker-2' });
    assert.equal(updateCalls[0].data.status, 'disconnected');
    assert.equal(typeof updateCalls[0].data.disconnected_at.toSqlString, 'function');
    assert.equal(typeof updateCalls[0].data.last_seen_at.toSqlString, 'function');
});

test('listPoolByOwner returns owner-scoped workers with latest offer details', async () => {
    const mysqlCalls = [];
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async find(table, options) {
                mysqlCalls.push({ table, options });

                if (table === 'workers') {
                    return [
                        {
                            id: 'worker-1',
                            user_id: 'owner-1',
                            status: 'disconnected',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: '2026-04-30T12:00:00.000Z',
                            last_seen_at: '2026-04-30T12:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T12:00:00.000Z'
                        },
                        {
                            id: 'worker-2',
                            user_id: 'owner-1',
                            status: 'disconnected',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: '2026-04-30T12:00:00.000Z',
                            last_seen_at: '2026-04-30T12:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T12:00:00.000Z'
                        }
                    ];
                }

                if (table === 'orders') {
                    return [
                        {
                            id: 20,
                            worker_id: 'worker-1',
                            model: 'model-latest',
                            price: '3.250000',
                            tps: 61,
                            is_available: 1,
                            is_consumed: 0,
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T13:00:00.000Z'
                        },
                        {
                            id: 10,
                            worker_id: 'worker-1',
                            model: 'model-older',
                            price: '2.500000',
                            tps: 45,
                            is_available: 1,
                            is_consumed: 0,
                            created_at: '2026-04-30T09:00:00.000Z',
                            updated_at: '2026-04-30T11:00:00.000Z'
                        }
                    ];
                }

                return [];
            }
        })
    });

    const result = await model.listPoolByOwner('owner-1', {
        runtimeWorkers: [
            { id: 'worker-1', connected: true, available: false, activeJobId: 'job-55' }
        ]
    });

    assert.equal(mysqlCalls.length, 2);
    assert.equal(mysqlCalls[0].table, 'workers');
    assert.deepEqual(mysqlCalls[0].options.filter, { user_id: 'owner-1' });
    assert.equal(mysqlCalls[1].table, 'orders');
    assert.deepEqual(mysqlCalls[1].options.filter, {
        user_id: 'owner-1',
        is_available: 1,
        is_consumed: 0
    });

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
        id: 'worker-1',
        userId: 'owner-1',
        status: 'busy',
        connected: true,
        available: false,
        activeJobId: 'job-55',
        model: 'model-latest',
        price: 3.25,
        tps: 61,
        offerId: 20,
        connectedAt: '2026-04-30T10:00:00.000Z',
        disconnectedAt: '2026-04-30T12:00:00.000Z',
        lastSeenAt: '2026-04-30T12:00:00.000Z',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T12:00:00.000Z'
    });

    assert.deepEqual(result[1], {
        id: 'worker-2',
        userId: 'owner-1',
        status: 'disconnected',
        connected: false,
        available: false,
        activeJobId: null,
        model: null,
        price: null,
        tps: null,
        offerId: null,
        connectedAt: '2026-04-30T10:00:00.000Z',
        disconnectedAt: '2026-04-30T12:00:00.000Z',
        lastSeenAt: '2026-04-30T12:00:00.000Z',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T12:00:00.000Z'
    });
});

test('listPoolByOwner rejects invalid owner ids', async () => {
    const model = new WorkersModel({ mysql: createMysqlStub() });

    await assert.rejects(
        () => model.listPoolByOwner(''),
        /ownerId must be a non-empty string/
    );
});

test('updatePerformanceTps persists observed TPS for the worker model offer', async () => {
    const updateCalls = [];
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    const observed = await model.updatePerformanceTps({
        workerId: ' worker-7 ',
        model: ' llama ',
        usage: { completion_tokens: 90 },
        startedAtMs: 1000,
        completedAtMs: 4000
    });

    assert.equal(observed, 30);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].table, 'orders');
    assert.deepEqual(updateCalls[0].data, { tps: 30 });
    assert.deepEqual(updateCalls[0].filter, {
        worker_id: 'worker-7',
        model: 'llama',
        is_available: 1,
        is_consumed: 0
    });
});

test('updatePerformanceTps returns null and skips persistence when metrics are incomplete', async () => {
    const updateCalls = [];
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    const observed = await model.updatePerformanceTps({
        workerId: 'worker-7',
        model: 'llama',
        usage: { total_tokens: 100, prompt_tokens: 100 },
        startedAtMs: 5000,
        completedAtMs: 5000
    });

    assert.equal(observed, null);
    assert.equal(updateCalls.length, 0);
});