import test from 'node:test';
import assert from 'node:assert/strict';

import { UsersModel } from '../../models/users.js';
import { Mysql } from '../../helpers/mysql.js';

const mysqlOriginals = {
    find: Mysql.find,
    findOne: Mysql.findOne,
    insert: Mysql.insert,
    update: Mysql.update,
    delete: Mysql.delete
};

test.afterEach(() => {
    Mysql.find = mysqlOriginals.find;
    Mysql.findOne = mysqlOriginals.findOne;
    Mysql.insert = mysqlOriginals.insert;
    Mysql.update = mysqlOriginals.update;
    Mysql.delete = mysqlOriginals.delete;
});

test('register maps ER_DUP_ENTRY to 409', async () => {
    const model = new UsersModel();
    Mysql.insert = async () => {
        const err = new Error('Duplicate entry');
        err.code = 'ER_DUP_ENTRY';
        throw err;
    };

    await assert.rejects(
        () => model.register({}),
        /already exists/
    );
});

test('getById throws 404 when user does not exist', async () => {
    const model = new UsersModel();
    Mysql.findOne = async () => null;

    await assert.rejects(
        () => model.getById('missing-user'),
        /User not found/
    );
});

test('updateById updates by id', async () => {
    const model = new UsersModel();
    let updated = null;

    Mysql.findOne = async (_table, { filter }) => {
        if (filter.id !== 'uuid-10') {
            return null;
        }

        return {
            id: 'uuid-10',
            name: 'Bob',
            email: 'bob@example.com',
            credits: 5,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
    };

    Mysql.update = async (_table, input, id) => {
        updated = { input, id };
        return { affectedRows: 1 };
    };

    const result = await model.updateById('uuid-10', { name: 'Bob' });
    assert.equal(updated.id, 'uuid-10');
    assert.equal(result.id, 'uuid-10');
    assert.equal(result.name, 'Bob');
});

test('rechargeById applies recharge on id', async () => {
    const model = new UsersModel();
    let charged = null;

    Mysql.findOne = async (_table, { filter }) => {
        if (filter.id !== 'uuid-7') {
            return null;
        }

        return {
            id: 'uuid-7',
            name: 'Jane',
            email: 'jane@example.com',
            credits: 15,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
    };

    Mysql.update = async (_table, input, id) => {
        charged = { input, id };
        return { affectedRows: 1 };
    };

    const result = await model.rechargeById('uuid-7', 15);
    assert.equal(charged.id, 'uuid-7');
    assert.deepEqual(charged.input, { credits: { inc: 15 } });
    assert.equal(result.id, 'uuid-7');
    assert.equal(result.credits, 15);
});

test('list forwards pagination options to driver', async () => {
    const model = new UsersModel();
    Mysql.find = async (_table, options) => [{
        id: 1,
        name: 'User 1',
        email: 'u1@example.com',
        credits: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        options
    }];

    const result = await model.list({ limit: 5, offset: 10 });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
    assert.equal(result[0].name, 'User 1');
});

test('deleteById resolves user and deletes by id', async () => {
    let deletedId = null;
    const model = new UsersModel();
    Mysql.findOne = async () => ({
        id: 'uuid-22',
        name: 'User 22',
        email: 'u22@example.com',
        credits: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
    });
    Mysql.delete = async (_table, id) => {
        deletedId = id;
    };

    await model.deleteById('uuid-22');
    assert.equal(deletedId, 'uuid-22');
});

test('deleteById throws 404 when user does not exist', async () => {
    const model = new UsersModel();
    Mysql.findOne = async () => null;

    await assert.rejects(
        () => model.deleteById('ghost'),
        /User not found/
    );
});

test('updateById maps ER_DUP_ENTRY to 409', async () => {
    const model = new UsersModel();
    Mysql.findOne = async () => ({
        id: 'uuid-5',
        name: 'User 5',
        email: 'u5@example.com',
        credits: 3,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
    });
    Mysql.update = async () => {
        const err = new Error('Duplicate entry for key users.email');
        err.code = 'ER_DUP_ENTRY';
        throw err;
    };

    await assert.rejects(
        () => model.updateById('uuid-5', { email: 'taken@example.com' }),
        /Email already in use/
    );
});
