import test from 'node:test';
import assert from 'node:assert/strict';

import { OrdersModel } from '../../models/orders.js';
import { Mysql } from '../../helpers/mysql.js';

const mysqlOriginals = {
    find: Mysql.find,
    findOne: Mysql.findOne,
    insert: Mysql.insert,
    update: Mysql.update,
    delete: Mysql.delete,
    withTransaction: Mysql.withTransaction,
    between: Mysql.between,
    gte: Mysql.gte,
    lte: Mysql.lte,
    raw: Mysql.raw
};

test.afterEach(() => {
    Mysql.find = mysqlOriginals.find;
    Mysql.findOne = mysqlOriginals.findOne;
    Mysql.insert = mysqlOriginals.insert;
    Mysql.update = mysqlOriginals.update;
    Mysql.delete = mysqlOriginals.delete;
    Mysql.withTransaction = mysqlOriginals.withTransaction;
    Mysql.between = mysqlOriginals.between;
    Mysql.gte = mysqlOriginals.gte;
    Mysql.lte = mysqlOriginals.lte;
    Mysql.raw = mysqlOriginals.raw;
});

function makeModel({ isWorkerConnected = () => true, isWorkerAvailable = () => true } = {}) {
    return new OrdersModel({
        streamRouter: {
            isWorkerConnected,
            isWorkerAvailable,
            isWorkerOwnedBy: () => true
        }
    });
}

function orderRow(overrides = {}) {
    return {
        id: 1,
        user_id: 'owner-1',
        worker_id: 'worker-1',
        model: 'llama',
        price: 1.5,
        tps: 20,
        is_available: 0,
        is_consumed: 0,
        consumed_at: null,
        created_at: '2026-04-30T00:00:00.000Z',
        updated_at: '2026-04-30T00:00:00.000Z',
        ...overrides
    };
}

test('create rejects orders for disconnected workers', async () => {
    const model = makeModel({ isWorkerConnected: () => false });

    await assert.rejects(
        () => model.create('owner-1', { workerId: 'w1', model: 'm', price: 1, tps: 10 }),
        /currently connected worker/
    );
});

test('create uses owner id and persists lifecycle defaults', async () => {
    const model = makeModel();

    Mysql.find = async () => [{ id: 'owner-1' }];
    let inserted = null;
    Mysql.insert = async (_table, data) => {
        inserted = data;
        return [{ insertId: 9 }];
    };
    Mysql.findOne = async (_table, { filter }) => {
        assert.equal(filter.id, 9);
        return orderRow({ id: 9 });
    };

    const created = await model.create('owner-1', {
        workerId: 'worker-1',
        model: 'llama',
        price: 2,
        tps: 30
    });

    assert.equal(inserted.user_id, 'owner-1');
    assert.equal(inserted.worker_id, 'worker-1');
    assert.equal(inserted.is_available, 0);
    assert.equal(inserted.is_consumed, 0);
    assert.equal(created.status, 'created');
});

test('updateOwn enforces owner scoping', async () => {
    const model = makeModel();
    Mysql.findOne = async () => orderRow({ id: 5, user_id: 'owner-2' });

    await assert.rejects(
        () => model.updateOwn('owner-1', 5, { price: 10 }),
        /only mutate your own orders/
    );
});

test('deleteOwn deletes only when owner matches', async () => {
    const model = makeModel();
    Mysql.findOne = async () => orderRow({ id: 99, user_id: 'owner-9' });

    let deleted = null;
    Mysql.delete = async (_table, id) => {
        deleted = id;
    };

    await model.deleteOwn('owner-9', 99);
    assert.equal(deleted, 99);
});

test('listPublic overlays runtime worker availability and supports onlyAvailable', async () => {
    const model = makeModel({
        isWorkerConnected(workerId) {
            return workerId !== 'w-offline';
        },
        isWorkerAvailable(workerId) {
            return workerId === 'w-ready';
        }
    });

    Mysql.find = async (_table, { filter }) => {
        assert.equal(filter.is_consumed, 0);
        return [
            orderRow({ id: 1, worker_id: 'w-ready' }),
            orderRow({ id: 2, worker_id: 'w-busy' }),
            orderRow({ id: 3, worker_id: 'w-offline' })
        ];
    };

    const all = await model.listPublic({ onlyAvailable: false, limit: 100, offset: 0 });
    assert.equal(all.length, 3);
    assert.equal(all[0].isAvailable, true);
    assert.equal(all[1].isAvailable, false);
    assert.equal(all[2].workerConnected, false);

    const filtered = await model.listPublic({ onlyAvailable: true, limit: 100, offset: 0 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].workerId, 'w-ready');
});

test('findFirstAvailableOfferByModel skips spoofed off-owner offers and returns ownership-coherent offer', async () => {
    const ownership = new Map([
        ['w-spoofed:owner-1', false],
        ['w-valid:owner-2', true]
    ]);
    const model = new OrdersModel({
        streamRouter: {
            isWorkerConnected: () => true,
            isWorkerAvailable: () => true,
            isWorkerOwnedBy(workerId, userId) {
                return ownership.get(`${workerId}:${userId}`) === true;
            }
        }
    });

    Mysql.find = async () => [
        orderRow({ id: 2, user_id: 'owner-1', worker_id: 'w-spoofed', model: 'gpt-4.1-mini', price: 99 }),
        orderRow({ id: 3, user_id: 'owner-2', worker_id: 'w-valid', model: 'gpt-4.1-mini', price: 4 })
    ];

    const selected = await model.findFirstAvailableOfferByModel('gpt-4.1-mini');
    assert.equal(selected.id, 3);
    assert.equal(selected.workerId, 'w-valid');
    assert.equal(selected.userId, 'owner-2');
    assert.equal(selected.price, 4);
});

test('consumeForUse maps insufficient credits to payment error', async () => {
    const model = makeModel();
    Mysql.findOne = async (_table, { filter }) => {
        if (filter?.id === 4) {
            return orderRow({ id: 4, worker_id: 'worker-1', is_consumed: 0 });
        }

        return null;
    };
    Mysql.withTransaction = async () => ({ status: 'insufficient_credits' });

    await assert.rejects(
        () => model.consumeForUse('consumer-1', 4),
        /Insufficient credits/
    );
});

test('consumeForUse returns consumed order payload with updated consumer', async () => {
    const model = makeModel();

    let inTransaction = false;
    Mysql.findOne = async (table, { filter }) => {
        if (table === 'orders' && filter?.id === 4) {
            return orderRow({ id: 4, worker_id: 'w-1', is_consumed: inTransaction ? 1 : 0 });
        }

        if (table === 'users' && filter?.id === 'consumer-1') {
            return { id: 'consumer-1', credits: 5 };
        }

        return null;
    };
    Mysql.update = async () => ({ affectedRows: 1 });
    Mysql.raw = () => ({ toSqlString: () => 'NOW()' });
    Mysql.withTransaction = async () => {
        inTransaction = true;
        return { status: 'consumed', orderId: 4, consumerId: 'consumer-1' };
    };

    const result = await model.consumeForUse('consumer-1', 4);
    assert.equal(result.status, 'consumed');
    assert.equal(result.order.workerId, 'w-1');
    assert.equal(result.order.status, 'running');
    assert.equal(result.consumer.credits, 5);
});

test('unconsumForUse treats not_consumed as idempotent no-op', async () => {
    const model = makeModel();
    Mysql.withTransaction = async () => ({ status: 'not_consumed' });

    const result = await model.unconsumForUse('consumer-1', 4);
    assert.equal(result.status, 'not_consumed');
});

test('settleCompletedOrder computes token cost, applies platform fee split, and completes order', async () => {
    const model = new OrdersModel({
        streamRouter: {
            isWorkerConnected: () => true,
            isWorkerAvailable: () => true
        },
        platformFeePercent: 20
    });

    const state = {
        inTransaction: false,
        order: orderRow({ id: 11, user_id: 'requester-1', worker_id: 'worker-1', is_consumed: 1, is_available: 0, price: 2.0 }),
        requester: { id: 'requester-1', credits: 10.0 },
        workerOwner: { id: 'owner-1', credits: 1.0 },
        worker: { id: 'worker-1', user_id: 'owner-1' }
    };

    Mysql.findOne = async (table, { filter }) => {
        if (table === 'orders' && filter?.id === 11) {
            return state.order;
        }

        if (table === 'users' && filter?.id === 'requester-1') {
            return state.requester;
        }

        if (table === 'users' && filter?.id === 'owner-1') {
            return state.workerOwner;
        }

        if (table === 'workers' && filter?.id === 'worker-1') {
            return state.worker;
        }

        return null;
    };

    Mysql.update = async (table, data, where) => {
        if (table === 'users' && where === 'requester-1') {
            state.requester = {
                ...state.requester,
                credits: Number((state.requester.credits - Number(data.credits.dec)).toFixed(6))
            };
            return { affectedRows: 1 };
        }

        if (table === 'users' && where === 'owner-1') {
            state.workerOwner = {
                ...state.workerOwner,
                credits: Number((state.workerOwner.credits + Number(data.credits.inc)).toFixed(6))
            };
            return { affectedRows: 1 };
        }

        if (table === 'orders') {
            state.order = {
                ...state.order,
                ...data
            };
            return { affectedRows: 1 };
        }

        return { affectedRows: 0 };
    };

    Mysql.withTransaction = async (operation) => operation({});

    const result = await model.settleCompletedOrder({
        orderId: 11,
        requesterId: 'requester-1',
        workerOwnerId: 'owner-1',
        usage: { total_tokens: 500000 }
    });

    assert.equal(result.status, 'settled');
    assert.equal(result.billing.totalCost, 1);
    assert.equal(result.billing.platformFeeAmount, 0.2);
    assert.equal(result.billing.workerCreditAmount, 0.8);
    assert.equal(result.order.status, 'completed');
    assert.equal(result.requester.credits, 9);
    assert.equal(result.workerOwner.credits, 1.8);
});

test('settleCompletedOrder rejects when requester does not own the order', async () => {
    const model = new OrdersModel({
        streamRouter: {
            isWorkerConnected: () => true,
            isWorkerAvailable: () => true
        },
        platformFeePercent: 20
    });

    Mysql.findOne = async (table, { filter }) => {
        if (table === 'orders' && filter?.id === 15) {
            return orderRow({ id: 15, user_id: 'actual-owner', worker_id: 'worker-1', is_consumed: 1, is_available: 0, price: 2.0 });
        }

        return null;
    };

    Mysql.withTransaction = async (operation) => operation({});

    await assert.rejects(
        () => model.settleCompletedOrder({
            orderId: 15,
            requesterId: 'different-requester',
            workerOwnerId: 'owner-1',
            usage: { total_tokens: 1000 }
        }),
        /Requester mismatch for settlement/
    );
});
