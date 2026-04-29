import test from 'node:test';
import assert from 'node:assert/strict';

import { UsersModel } from '../../models/users.js';

/**
 * Builds a users model plus mutable fake driver stubs for each scenario.
 * @param {Partial<import('../../drivers/mysql/users.js').UsersDriver>} methods
 * @returns {UsersModel}
 */
function makeModel(methods) {
    return new UsersModel({ usersDriver: methods });
}

test('register rejects duplicated externalId', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return { id: 1, externalId: 'user-1' };
        }
    });

    await assert.rejects(
        () => model.register({ externalId: 'user-1' }),
        /already exists/
    );
});

test('getByExternalId throws 404 when user does not exist', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return null;
        }
    });

    await assert.rejects(
        () => model.getByExternalId('missing-user'),
        /User not found/
    );
});

test('updateByExternalId updates by internal id', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return { id: 10, externalId: 'user-10' };
        },
        async updateUser(id, input) {
            return { id, externalId: 'user-10', ...input };
        }
    });

    const result = await model.updateByExternalId('user-10', { name: 'Bob' });
    assert.equal(result.id, 10);
    assert.equal(result.name, 'Bob');
});

test('rechargeByExternalId applies recharge on internal id', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return { id: 7, externalId: 'user-7' };
        },
        async rechargeCredits(id, amount) {
            return { id, credits: amount };
        }
    });

    const result = await model.rechargeByExternalId('user-7', 15);
    assert.equal(result.id, 7);
    assert.equal(result.credits, 15);
});

test('list forwards pagination options to driver', async () => {
    const model = makeModel({
        async listUsers(options) {
            return [{ id: 1, options }];
        }
    });

    const result = await model.list({ limit: 5, offset: 10 });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].options, { limit: 5, offset: 10 });
});

test('deleteByExternalId resolves user and deletes by internal id', async () => {
    let deletedId = null;
    const model = makeModel({
        async getUserByExternalId() {
            return { id: 22, externalId: 'user-22' };
        },
        async deleteUser(id) {
            deletedId = id;
            return true;
        }
    });

    await model.deleteByExternalId('user-22');
    assert.equal(deletedId, 22);
});

test('deleteByExternalId throws 404 when user does not exist', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return null;
        }
    });

    await assert.rejects(
        () => model.deleteByExternalId('ghost'),
        /User not found/
    );
});

test('register maps ER_DUP_ENTRY from driver to 409', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return null;
        },
        async createUser() {
            const err = new Error('Duplicate entry');
            err.code = 'ER_DUP_ENTRY';
            throw err;
        }
    });

    await assert.rejects(
        () => model.register({ externalId: 'u1' }),
        /already exists/
    );
});

test('updateByExternalId maps ER_DUP_ENTRY from driver to 409', async () => {
    const model = makeModel({
        async getUserByExternalId() {
            return { id: 5, externalId: 'u5' };
        },
        async updateUser() {
            const err = new Error('Duplicate entry');
            err.code = 'ER_DUP_ENTRY';
            throw err;
        }
    });

    await assert.rejects(
        () => model.updateByExternalId('u5', { email: 'taken@example.com' }),
        /Email already in use/
    );
});
