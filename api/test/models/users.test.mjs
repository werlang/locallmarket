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

test('register maps ER_DUP_ENTRY to 409', async () => {
    const model = makeModel({
        async getUserById() {
            return null;
        },
        async createUser() {
            const err = new Error('Duplicate entry');
            err.code = 'ER_DUP_ENTRY';
            throw err;
        }
    });

    await assert.rejects(
        () => model.register({}),
        /already exists/
    );
});

test('getById throws 404 when user does not exist', async () => {
    const model = makeModel({
        async getUserById() {
            return null;
        }
    });

    await assert.rejects(
        () => model.getById('missing-user'),
        /User not found/
    );
});

test('updateById updates by id', async () => {
    const model = makeModel({
        async getUserById() {
            return { id: 'uuid-10' };
        },
        async updateUser(id, input) {
            return { id, ...input };
        }
    });

    const result = await model.updateById('uuid-10', { name: 'Bob' });
    assert.equal(result.id, 'uuid-10');
    assert.equal(result.name, 'Bob');
});

test('rechargeById applies recharge on id', async () => {
    const model = makeModel({
        async getUserById() {
            return { id: 'uuid-7' };
        },
        async rechargeCredits(id, amount) {
            return { id, credits: amount };
        }
    });

    const result = await model.rechargeById('uuid-7', 15);
    assert.equal(result.id, 'uuid-7');
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

test('deleteById resolves user and deletes by id', async () => {
    let deletedId = null;
    const model = makeModel({
        async getUserById() {
            return { id: 'uuid-22' };
        },
        async deleteUser(id) {
            deletedId = id;
            return true;
        }
    });

    await model.deleteById('uuid-22');
    assert.equal(deletedId, 'uuid-22');
});

test('deleteById throws 404 when user does not exist', async () => {
    const model = makeModel({
        async getUserById() {
            return null;
        }
    });

    await assert.rejects(
        () => model.deleteById('ghost'),
        /User not found/
    );
});

test('updateById maps ER_DUP_ENTRY to 409', async () => {
    const model = makeModel({
        async getUserById() {
            return { id: 'uuid-5' };
        },
        async updateUser() {
            const err = new Error('Duplicate entry');
            err.code = 'ER_DUP_ENTRY';
            throw err;
        }
    });

    await assert.rejects(
        () => model.updateById('uuid-5', { email: 'taken@example.com' }),
        /Email already in use/
    );
});
