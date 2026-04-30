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