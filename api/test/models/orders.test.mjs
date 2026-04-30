import test from 'node:test';
import assert from 'node:assert/strict';

import { OrdersModel } from '../../models/orders.js';

/**
 * @param {Partial<OrdersModel>} methods
 */
function makeModel({ ordersDriver = {}, usersDriver = {}, isWorkerConnected = () => true, isWorkerAvailable = () => true } = {}) {
    return new OrdersModel({
        ordersDriver,
        usersDriver,
        isWorkerConnected,
        isWorkerAvailable
    });
}

test('create rejects orders for disconnected workers', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() {
                return { id: 1 };
            }
        },
        isWorkerConnected: () => false
    });

    await assert.rejects(
        () => model.create('owner-1', { workerId: 'w1', model: 'm', price: 1, tps: 10, isAvailable: true }),
        /currently connected worker/
    );
});

test('create uses owner internal id when persisting', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() {
                return { id: 42 };
            }
        },
        ordersDriver: {
            async createOrder(input) {
                return { id: 9, ...input };
            }
        }
    });

    const created = await model.create('owner-1', {
        workerId: 'worker-1',
        model: 'llama',
        price: 2,
        tps: 30,
        isAvailable: true
    });

    assert.equal(created.userId, 42);
    assert.equal(created.workerId, 'worker-1');
});

test('updateOwn enforces owner scoping', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() {
                return { id: 2 };
            }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 5, userId: 3, workerId: 'w1', isAvailable: true };
            }
        }
    });

    await assert.rejects(
        () => model.updateOwn('owner-2', 5, { price: 10 }),
        /only mutate your own orders/
    );
});

test('deleteOwn deletes only when owner matches', async () => {
    let deleted = null;
    const model = makeModel({
        usersDriver: {
            async getUserById() {
                return { id: 7 };
            }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 99, userId: 7, workerId: 'w2', isAvailable: true };
            },
            async deleteOrder(id) {
                deleted = id;
                return true;
            }
        }
    });

    await model.deleteOwn('owner-7', 99);
    assert.equal(deleted, 99);
});

test('listPublic overlays runtime worker availability and supports onlyAvailable', async () => {
    const model = makeModel({
        ordersDriver: {
            async listOrders() {
                return [
                    { id: 1, workerId: 'w-ready', isAvailable: true, isConsumed: false },
                    { id: 2, workerId: 'w-busy', isAvailable: true, isConsumed: false },
                    { id: 3, workerId: 'w-offline', isAvailable: true, isConsumed: false }
                ];
            }
        },
        isWorkerConnected(workerId) {
            return workerId !== 'w-offline';
        },
        isWorkerAvailable(workerId) {
            return workerId === 'w-ready';
        }
    });

    const all = await model.listPublic({ onlyAvailable: false, limit: 100, offset: 0 });
    assert.equal(all.length, 3);
    assert.equal(all[0].isAvailable, true);
    assert.equal(all[1].isAvailable, false);
    assert.equal(all[2].workerConnected, false);

    const filtered = await model.listPublic({ onlyAvailable: true, limit: 100, offset: 0 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].workerId, 'w-ready');
});

test('consumeForUse rejects when order worker is disconnected', async () => {
    const model = makeModel({
        ordersDriver: {
            async getOrderById() {
                return { id: 4, workerId: 'w-offline', isConsumed: false, isAvailable: true };
            }
        },
        isWorkerConnected: () => false
    });

    await assert.rejects(
        () => model.consumeForUse('consumer-1', 4),
        /not connected/
    );
});

test('consumeForUse maps insufficient credits to payment error', async () => {
    const model = makeModel({
        ordersDriver: {
            async getOrderById() {
                return { id: 4, workerId: 'w-1', isConsumed: false, isAvailable: true };
            },
            async consumeOrderForUse() {
                return { status: 'insufficient_credits' };
            }
        }
    });

    await assert.rejects(
        () => model.consumeForUse('consumer-1', 4),
        /Insufficient credits/
    );
});

test('consumeForUse returns consumed order payload', async () => {
    const model = makeModel({
        ordersDriver: {
            async getOrderById() {
                return { id: 4, workerId: 'w-1', isConsumed: false, isAvailable: true };
            },
            async consumeOrderForUse() {
                return {
                    status: 'consumed',
                    order: { id: 4, workerId: 'w-1', model: 'llama' },
                    consumer: { id: 9, credits: 2 }
                };
            }
        }
    });

    const result = await model.consumeForUse('consumer-1', 4);
    assert.equal(result.status, 'consumed');
    assert.equal(result.order.workerId, 'w-1');
});

test('unconsumForUse calls driver and returns restored status', async () => {
    const restoredResult = {
        status: 'restored',
        order: { id: 4, isConsumed: false, isAvailable: true },
        consumer: { id: 9, credits: 5 }
    };
    let driverCalled = false;

    const model = makeModel({
        ordersDriver: {
            async unconsumOrderForUse({ orderId, consumerId }) {
                assert.equal(orderId, 4);
                assert.equal(consumerId, 'consumer-1');
                driverCalled = true;
                return restoredResult;
            }
        }
    });

    const result = await model.unconsumForUse('consumer-1', 4);
    assert.equal(driverCalled, true);
    assert.equal(result.status, 'restored');
    assert.equal(result.order.isConsumed, false);
});

test('unconsumForUse treats not_consumed as idempotent no-op', async () => {
    const model = makeModel({
        ordersDriver: {
            async unconsumOrderForUse() {
                return { status: 'not_consumed' };
            }
        }
    });

    const result = await model.unconsumForUse('consumer-1', 4);
    assert.equal(result.status, 'not_consumed');
});

test('unconsumForUse throws 404 when driver returns order_not_found', async () => {
    const model = makeModel({
        ordersDriver: {
            async unconsumOrderForUse() {
                return { status: 'order_not_found' };
            }
        }
    });

    await assert.rejects(
        () => model.unconsumForUse('consumer-1', 99),
        /Order not found during compensation/
    );
});

test('unconsumForUse throws 404 when driver returns consumer_not_found', async () => {
    const model = makeModel({
        ordersDriver: {
            async unconsumOrderForUse() {
                return { status: 'consumer_not_found' };
            }
        }
    });

    await assert.rejects(
        () => model.unconsumForUse('ghost-consumer', 4),
        /Consumer user not found during compensation/
    );
});

// ---------------------------------------------------------------------------
// T03 – orderbook CRUD + connected-worker requirement
// ---------------------------------------------------------------------------

test('create throws 404 when owner user is not found', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() { return null; }
        }
    });

    await assert.rejects(
        () => model.create('unknown-owner', { workerId: 'w1', model: 'm', price: 1, tps: 10, isAvailable: true }),
        /Owner user not found/
    );
});

test('getOwnById returns order when owner matches', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() { return { id: 5 }; }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 10, userId: 5, workerId: 'w1', model: 'llama', price: 1, tps: 20, isAvailable: true };
            }
        }
    });

    const order = await model.getOwnById('owner-5', 10);
    assert.equal(order.id, 10);
    assert.equal(order.workerId, 'w1');
});

test('getOwnById throws 404 when order is not found', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() { return { id: 5 }; }
        },
        ordersDriver: {
            async getOrderById() { return null; }
        }
    });

    await assert.rejects(
        () => model.getOwnById('owner-5', 999),
        /Order not found/
    );
});

test('getOwnById throws 403 when order belongs to a different user', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() { return { id: 5 }; }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 10, userId: 99, workerId: 'w1', isAvailable: true };
            }
        }
    });

    await assert.rejects(
        () => model.getOwnById('owner-5', 10),
        /only mutate your own orders/
    );
});

test('updateOwn returns updated order when owner matches and update is valid', async () => {
    let updatedWith = null;
    const model = makeModel({
        usersDriver: {
            async getUserById() { return { id: 7 }; }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 20, userId: 7, workerId: 'w1', isAvailable: true };
            },
            async updateOrder(id, updates) {
                updatedWith = { id, updates };
                return { id, ...updates };
            }
        }
    });

    const updated = await model.updateOwn('owner-7', 20, { price: 5 });
    assert.equal(updated.id, 20);
    assert.equal(updated.price, 5);
    assert.deepEqual(updatedWith, { id: 20, updates: { price: 5 } });
});

test('updateOwn rejects new workerId that references a disconnected worker', async () => {
    const model = makeModel({
        usersDriver: {
            async getUserById() { return { id: 7 }; }
        },
        ordersDriver: {
            async getOrderById() {
                return { id: 20, userId: 7, workerId: 'w-old', isAvailable: true };
            }
        },
        isWorkerConnected: (workerId) => workerId !== 'w-new-offline'
    });

    await assert.rejects(
        () => model.updateOwn('owner-7', 20, { workerId: 'w-new-offline' }),
        /currently connected worker/
    );
});

