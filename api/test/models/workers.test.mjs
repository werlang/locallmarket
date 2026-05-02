import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkersModel } from '../../models/workers.js';

const UPTIME_WINDOW_SECONDS = 24 * 60 * 60;
const SERVED_REQUESTS_TARGET_24H = 1000;

function computeExpectedReputation(seconds, servedRequests = 0) {
    const uptimeScore = Number(((seconds / UPTIME_WINDOW_SECONDS) * 100).toFixed(6));
    const requestsScore = Number(((Math.min(servedRequests, SERVED_REQUESTS_TARGET_24H) / SERVED_REQUESTS_TARGET_24H) * 100).toFixed(6));
    return Number((uptimeScore + requestsScore).toFixed(6));
}

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
                    model: 'llama3',
                    tps: 20,
                    price: 1.5,
                    status: 'available',
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
        () => model.bindConnectedWorker({ workerId: 'worker-1', apiKey: 'a'.repeat(64), model: 'llama3', tps: 20, price: 1.5 }),
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
                model: 'llama3',
                tps: 20,
                price: '1.500000',
                status: 'available',
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

    const result = await model.bindConnectedWorker({ workerId: ' worker-1 ', apiKey: 'a'.repeat(64), model: 'llama3', tps: 20, price: 1.5 });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
    assert.equal(upsertCalls[0].data.id, 'worker-1');
    assert.equal(upsertCalls[0].data.user_id, 'user-1');
    assert.equal(upsertCalls[0].data.model, 'llama3');
    assert.equal(upsertCalls[0].data.tps, 20);
    assert.equal(upsertCalls[0].data.price, 1.5);
    assert.equal(upsertCalls[0].data.status, 'available');
    assert.equal(typeof upsertCalls[0].data.connected_at.toSqlString, 'function');
    assert.equal(typeof upsertCalls[0].data.uptime_window_started_at.toSqlString, 'function');
    assert.equal(typeof upsertCalls[0].data.served_window_started_at.toSqlString, 'function');
    assert.equal(upsertCalls[0].data.uptime_24h_seconds, 0);
    assert.equal(upsertCalls[0].data.served_requests_24h, 0);
    assert.equal(upsertCalls[0].data.reputation, 0);
    assert.equal(result.user.id, 'user-1');
    assert.equal(result.worker.id, 'worker-1');
    assert.equal(result.worker.userId, 'user-1');
    assert.equal(result.worker.model, 'llama3');
    assert.equal(result.worker.tps, 20);
    assert.equal(result.worker.price, 1.5);
    assert.equal(result.identity.workerId, 'worker-1');
    assert.equal(result.identity.ownerId, 'user-1');
    assert.equal(typeof result.identity.token, 'string');
    assert.ok(result.identity.token.length > 0);
});

test('bindConnectedWorker accepts token input and reuses resolved worker identity on reconnect', async () => {
    const upsertCalls = [];
    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne(table, options) {
            if (options?.filter?.id === 'worker-existing') {
                return {
                    id: 'worker-existing',
                    user_id: 'user-1',
                    model: 'llama3',
                    tps: 20,
                    price: '1.500000',
                    status: 'available',
                    connected_at: '2026-04-30T10:00:00.000Z',
                    disconnected_at: null,
                    last_seen_at: '2026-04-30T10:00:00.000Z',
                    created_at: '2026-04-30T10:00:00.000Z',
                    updated_at: '2026-04-30T10:00:00.000Z'
                };
            }

            return {
                id: 'worker-1',
                user_id: 'user-1',
                model: 'llama3',
                tps: 20,
                price: '1.500000',
                status: 'available',
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

    const first = await model.bindConnectedWorker({
        workerId: 'worker-existing',
        apiKey: 'a'.repeat(64),
        model: 'llama3',
        tps: 20,
        price: 1.5
    });

    const result = await model.bindConnectedWorker({
        workerId: 'worker-new-ephemeral',
        token: first.identity.token,
        apiKey: 'a'.repeat(64),
        model: 'llama3',
        tps: 20,
        price: 1.5
    });

    assert.equal(result.identity.workerId, 'worker-existing');
    assert.equal(result.identity.ownerId, 'user-1');
    assert.equal(result.identity.token, first.identity.token);
    assert.equal(upsertCalls[1].data.id, 'worker-existing');
});

test('bindConnectedWorker issues a new token and registers worker when token is invalid', async () => {
    const upsertCalls = [];
    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne(table, options) {
            if (options?.filter?.id === 'worker-new') {
                return {
                    id: 'worker-new',
                    user_id: 'user-1',
                    model: 'llama3',
                    tps: 20,
                    price: '1.500000',
                    status: 'available',
                    connected_at: '2026-04-30T10:00:00.000Z',
                    disconnected_at: null,
                    last_seen_at: '2026-04-30T10:00:00.000Z',
                    created_at: '2026-04-30T10:00:00.000Z',
                    updated_at: '2026-04-30T10:00:00.000Z'
                };
            }

            return null;
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

    const result = await model.bindConnectedWorker({
        workerId: 'worker-new',
        token: 'w1.invalid.signature',
        apiKey: 'a'.repeat(64),
        model: 'llama3',
        tps: 20,
        price: 1.5
    });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].data.id, 'worker-new');
    assert.equal(result.identity.workerId, 'worker-new');
    assert.equal(typeof result.identity.token, 'string');
    assert.notEqual(result.identity.token, 'w1.invalid.signature');
    const resolved = await model.getByTokenOrNull(result.identity.token);
    assert.ok(resolved);
    assert.equal(resolved.id, 'worker-new');
});

test('getByTokenOrNull resolves worker row only when token owner matches', async () => {
    const mysql = createMysqlStub({
        async findOne(table, options) {
            if (options?.filter?.id === 'worker-token') {
                return {
                    id: 'worker-token',
                    user_id: 'user-1',
                    model: 'llama3',
                    tps: 20,
                    price: '1.500000',
                    status: 'available',
                    connected_at: '2026-04-30T10:00:00.000Z',
                    disconnected_at: null,
                    last_seen_at: '2026-04-30T10:00:00.000Z',
                    created_at: '2026-04-30T10:00:00.000Z',
                    updated_at: '2026-04-30T10:00:00.000Z'
                };
            }

            return null;
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

    const registration = await model.bindConnectedWorker({
        workerId: 'worker-token',
        apiKey: 'a'.repeat(64),
        model: 'llama3',
        tps: 20,
        price: 1.5
    });

    const resolved = await model.getByTokenOrNull(registration.identity.token, {
        expectedOwnerId: 'user-1'
    });
    assert.ok(resolved);
    assert.equal(resolved.id, 'worker-token');

    const mismatched = await model.getByTokenOrNull(registration.identity.token, {
        expectedOwnerId: 'user-2'
    });
    assert.equal(mismatched, null);
});

test('bindConnectedWorker reconnect keeps ownership immutable and only updates lifecycle fields', async () => {
    const upsertCalls = [];
    const existingRow = {
        id: 'worker-immutable',
        user_id: 'user-1',
        model: 'llama3',
        tps: 20,
        price: '1.500000',
        status: 'available',
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

    const result = await model.bindConnectedWorker({ workerId: 'worker-immutable', apiKey: 'a'.repeat(64), model: 'llama3', tps: 20, price: 1.5 });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
    assert.equal(upsertCalls[0].data.user_id, 'user-1');
    assert.equal(upsertCalls[0].data.model, 'llama3');
    assert.equal(upsertCalls[0].data.status, 'available');
    assert.ok(upsertCalls[0].options.updateFields.includes('model'));
    assert.equal(upsertCalls[0].options.updateFields.includes('user_id'), false);
    assert.ok(upsertCalls[0].options.updateFields.includes('tps'));
    assert.ok(upsertCalls[0].options.updateFields.includes('price'));
    assert.ok(upsertCalls[0].options.updateFields.includes('status'));
    assert.ok(upsertCalls[0].options.updateFields.includes('connected_at'));
    assert.equal(typeof upsertCalls[0].data.connected_at.toSqlString, 'function');
    assert.equal(typeof upsertCalls[0].data.last_seen_at.toSqlString, 'function');
    assert.equal(upsertCalls[0].data.disconnected_at, null);
    assert.equal(result.worker.userId, 'user-1');
});

test('bindConnectedWorker rejects if ownership changes during concurrent registration race', async () => {
    const upsertCalls = [];
    let racedRow = null;

    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });

            // Simulate a race: row appears between pre-check and upsert, owned by another user.
            if (!racedRow) {
                racedRow = {
                    id: 'worker-race',
                    user_id: 'user-2',
                    model: 'llama3-old',
                    tps: 11,
                    price: '9.990000',
                    status: 'available',
                    connected_at: '2026-04-30T10:00:00.000Z',
                    disconnected_at: null,
                    last_seen_at: '2026-04-30T10:00:00.000Z',
                    created_at: '2026-04-30T10:00:00.000Z',
                    updated_at: '2026-04-30T10:00:00.000Z'
                };
            }

            for (const field of options.updateFields) {
                racedRow[field] = data[field];
            }
        },
        async findOne() {
            return racedRow;
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
        () => model.bindConnectedWorker({ workerId: 'worker-race', apiKey: 'a'.repeat(64), model: 'llama3', tps: 20, price: 1.5 }),
        /already belongs to another user/
    );

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].table, 'workers');
    assert.equal(upsertCalls[0].options.updateFields.includes('user_id'), false);
    assert.equal(racedRow.user_id, 'user-2');
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
    assert.equal(updateCalls[0].data.uptime_24h_seconds, 0);
    assert.equal(updateCalls[0].data.served_requests_24h, 0);
    assert.equal(updateCalls[0].data.reputation, 0);
});

test('incrementServedRequests increments count in active window and updates reputation contribution', async () => {
    const updateCalls = [];
    const nowMs = Date.parse('2026-05-01T12:00:00.000Z');
    const model = new WorkersModel({
        now: () => nowMs,
        mysql: createMysqlStub({
            async findOne() {
                return {
                    id: 'worker-served',
                    user_id: 'user-1',
                    status: 'disconnected',
                    connected_at: '2026-05-01T11:45:00.000Z',
                    uptime_window_started_at: '2026-05-01T10:00:00.000Z',
                    uptime_24h_seconds: 3600,
                    served_window_started_at: '2026-05-01T10:00:00.000Z',
                    served_requests_24h: 4
                };
            },
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    await model.incrementServedRequests(' worker-served ');

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].table, 'workers');
    assert.deepEqual(updateCalls[0].filter, { id: 'worker-served' });
    assert.equal(updateCalls[0].data.uptime_24h_seconds, 3600);
    assert.equal(updateCalls[0].data.served_requests_24h, 5);
    assert.equal(updateCalls[0].data.reputation, computeExpectedReputation(3600, 5));
    assert.ok(updateCalls[0].data.served_window_started_at instanceof Date);
    assert.equal(updateCalls[0].data.served_window_started_at.toISOString(), '2026-05-01T10:00:00.000Z');
});

test('incrementServedRequests resets stale 24h served window before incrementing', async () => {
    const updateCalls = [];
    const nowMs = Date.parse('2026-05-01T12:00:00.000Z');
    const model = new WorkersModel({
        now: () => nowMs,
        mysql: createMysqlStub({
            async findOne() {
                return {
                    id: 'worker-served-reset',
                    user_id: 'user-1',
                    status: 'disconnected',
                    connected_at: '2026-04-29T11:45:00.000Z',
                    uptime_window_started_at: '2026-04-29T11:00:00.000Z',
                    uptime_24h_seconds: 720,
                    served_window_started_at: '2026-04-29T11:00:00.000Z',
                    served_requests_24h: 27
                };
            },
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    await model.incrementServedRequests('worker-served-reset');

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].data.served_requests_24h, 1);
    assert.ok(updateCalls[0].data.served_window_started_at instanceof Date);
    assert.equal(updateCalls[0].data.served_window_started_at.toISOString(), '2026-05-01T12:00:00.000Z');
    assert.equal(updateCalls[0].data.reputation, computeExpectedReputation(0, 1));
});

test('bindConnectedWorker reconnect accrues uptime delta into 24h metrics and reputation', async () => {
    const upsertCalls = [];
    const nowMs = Date.parse('2026-05-01T12:00:00.000Z');
    const existingWorkerRow = {
        id: 'worker-uptime',
        user_id: 'user-1',
        model: 'llama3',
        tps: 20,
        price: '1.500000',
        status: 'available',
        connected_at: '2026-05-01T11:30:00.000Z',
        disconnected_at: null,
        uptime_window_started_at: '2026-05-01T10:00:00.000Z',
        uptime_24h_seconds: 1200,
        served_window_started_at: '2026-05-01T10:00:00.000Z',
        served_requests_24h: 7,
        last_seen_at: '2026-05-01T11:30:00.000Z',
        created_at: '2026-05-01T10:00:00.000Z',
        updated_at: '2026-05-01T11:30:00.000Z'
    };

    const mysql = createMysqlStub({
        async upsert(table, data, options) {
            upsertCalls.push({ table, data, options });
        },
        async findOne(table, options) {
            if (table !== 'workers') return null;

            if (options?.view?.includes('model')) {
                return existingWorkerRow;
            }

            return {
                id: 'worker-uptime',
                user_id: 'user-1',
                status: 'available',
                connected_at: '2026-05-01T11:30:00.000Z',
                uptime_window_started_at: '2026-05-01T10:00:00.000Z',
                uptime_24h_seconds: 1200,
                served_window_started_at: '2026-05-01T10:00:00.000Z',
                served_requests_24h: 7
            };
        }
    });

    const model = new WorkersModel({
        mysql,
        now: () => nowMs,
        users: {
            async getByApiKeyOrNull() {
                return { id: 'user-1' };
            }
        }
    });

    await model.bindConnectedWorker({
        workerId: 'worker-uptime',
        apiKey: 'a'.repeat(64),
        model: 'llama3',
        tps: 20,
        price: 1.5
    });

    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].data.uptime_24h_seconds, 3000);
    assert.equal(upsertCalls[0].data.served_requests_24h, 7);
    assert.equal(upsertCalls[0].data.reputation, computeExpectedReputation(3000, 7));
    assert.ok(upsertCalls[0].data.uptime_window_started_at instanceof Date);
    assert.equal(upsertCalls[0].data.uptime_window_started_at.toISOString(), '2026-05-01T10:00:00.000Z');
});

test('markDisconnected accrues connected uptime delta and resets stale 24h windows', async () => {
    const updateCalls = [];
    const nowMs = Date.parse('2026-05-01T12:00:00.000Z');
    const model = new WorkersModel({
        now: () => nowMs,
        mysql: createMysqlStub({
            async findOne() {
                return {
                    id: 'worker-2',
                    user_id: 'user-1',
                    status: 'busy',
                    connected_at: '2026-04-30T08:00:00.000Z',
                    uptime_window_started_at: '2026-04-30T08:00:00.000Z',
                    uptime_24h_seconds: 600,
                    served_window_started_at: '2026-04-30T08:00:00.000Z',
                    served_requests_24h: 11
                };
            },
            async update(table, data, filter) {
                updateCalls.push({ table, data, filter });
            }
        })
    });

    await model.markDisconnected('worker-2');

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].data.uptime_24h_seconds, 0);
    assert.equal(updateCalls[0].data.served_requests_24h, 0);
    assert.equal(updateCalls[0].data.reputation, 0);
    assert.ok(updateCalls[0].data.uptime_window_started_at instanceof Date);
    assert.equal(updateCalls[0].data.uptime_window_started_at.toISOString(), '2026-05-01T12:00:00.000Z');
    assert.ok(updateCalls[0].data.served_window_started_at instanceof Date);
    assert.equal(updateCalls[0].data.served_window_started_at.toISOString(), '2026-05-01T12:00:00.000Z');
});

test('listPoolByOwner returns owner-scoped workers with runtime state', async () => {
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
                            model: 'llama3',
                            tps: 61,
                            price: '3.250000',
                            status: 'available',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: null,
                            last_seen_at: '2026-04-30T12:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T12:00:00.000Z'
                        },
                        {
                            id: 'worker-2',
                            user_id: 'owner-1',
                            model: null,
                            tps: null,
                            price: null,
                            status: 'disconnected',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: '2026-04-30T12:00:00.000Z',
                            last_seen_at: '2026-04-30T12:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T12:00:00.000Z'
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

    assert.equal(mysqlCalls.length, 1);
    assert.equal(mysqlCalls[0].table, 'workers');
    assert.deepEqual(mysqlCalls[0].options.filter, { user_id: 'owner-1' });

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
        id: 'worker-1',
        userId: 'owner-1',
        model: 'llama3',
        tps: 61,
        price: 3.25,
        status: 'busy',
        connected: true,
        available: false,
        activeJobId: 'job-55',
        connectedAt: '2026-04-30T10:00:00.000Z',
        disconnectedAt: null,
        lastSeenAt: '2026-04-30T12:00:00.000Z',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T12:00:00.000Z'
    });

    assert.deepEqual(result[1], {
        id: 'worker-2',
        userId: 'owner-1',
        model: null,
        tps: null,
        price: null,
        status: 'disconnected',
        connected: false,
        available: false,
        activeJobId: null,
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

test('listPool returns public data for workers across owners', async () => {
    const model = new WorkersModel({
        mysql: createMysqlStub({
            async find(table) {
                if (table === 'workers') {
                    return [
                        {
                            id: 'worker-1',
                            user_id: 'owner-1',
                            model: 'gpt-oss',
                            tps: 33,
                            price: '2.000000',
                            status: 'available',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: null,
                            last_seen_at: '2026-04-30T12:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T12:00:00.000Z'
                        },
                        {
                            id: 'worker-2',
                            user_id: 'owner-2',
                            model: null,
                            tps: null,
                            price: null,
                            status: 'disconnected',
                            connected_at: '2026-04-30T10:00:00.000Z',
                            disconnected_at: '2026-04-30T11:00:00.000Z',
                            last_seen_at: '2026-04-30T11:00:00.000Z',
                            created_at: '2026-04-30T10:00:00.000Z',
                            updated_at: '2026-04-30T11:00:00.000Z'
                        }
                    ];
                }

                return [];
            }
        })
    });

    const pool = await model.listPool({
        runtimeWorkers: [
            { id: 'worker-1', connected: true, available: true, activeJobId: null }
        ]
    });

    assert.equal(pool.length, 2);
    assert.deepEqual(pool[0], {
        id: 'worker-1',
        userId: 'owner-1',
        model: 'gpt-oss',
        tps: 33,
        price: 2,
        status: 'available',
        connected: true,
        available: true,
        activeJobId: null,
        connectedAt: '2026-04-30T10:00:00.000Z',
        disconnectedAt: null,
        lastSeenAt: '2026-04-30T12:00:00.000Z',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T12:00:00.000Z'
    });
    assert.equal(pool[1].id, 'worker-2');
    assert.equal(pool[1].userId, 'owner-2');
});

test('updatePerformanceTps persists observed TPS on the worker row', async () => {
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
        usage: { completion_tokens: 90 },
        startedAtMs: 1000,
        completedAtMs: 4000
    });

    assert.equal(observed, 30);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].table, 'workers');
    assert.deepEqual(updateCalls[0].data, { tps: 30 });
    assert.deepEqual(updateCalls[0].filter, { id: 'worker-7' });
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