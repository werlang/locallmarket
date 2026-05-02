import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Mysql } from '../../helpers/mysql.js';
import { CustomError } from '../../helpers/error.js';

describe('Mysql write payload handling', () => {
    it('insert() drops undefined fields and preserves null values', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ { affectedRows: 1 } ];
            }
        };

        await Mysql.insert('users', {
            email: 'john@example.com',
            nickname: null,
            ignored: undefined
        }, { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'INSERT INTO `users` (`email`,`nickname`) VALUES (?,?)');
        assert.deepEqual(calls[0].data, [ 'john@example.com', null ]);
    });

    it('insert() throws CustomError when row is null', async () => {
        await assert.rejects(
            Mysql.insert('users', [ null ], { connection: { execute: async () => [ [] ] } }),
            (error) => error instanceof CustomError && error.message === 'Invalid data for insert operation.',
        );
    });

    it('upsert() drops undefined fields and preserves null values', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ { affectedRows: 1 } ];
            }
        };

        await Mysql.upsert(
            'users',
            {
                email: 'john@example.com',
                profile_name: undefined,
                nickname: null
            },
            { conflictFields: [ 'email' ] },
            { connection },
        );

        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].sql,
            'INSERT INTO `users` (`email`, `nickname`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `nickname` = VALUES(`nickname`)',
        );
        assert.deepEqual(calls[0].data, [ 'john@example.com', null ]);
    });

    it('update() preserves null bindings', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ { affectedRows: 1 } ];
            }
        };

        await Mysql.update('users', { nickname: null }, 'user-1', { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'UPDATE `users` SET `nickname` = ? WHERE `id` = ?');
        assert.deepEqual(calls[0].data, [ null, 'user-1' ]);
    });

    it('update() keeps null bindings when raw SQL is mixed in the payload', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ { affectedRows: 1 } ];
            }
        };

        await Mysql.update('users', {
            nickname: null,
            updated_at: Mysql.raw('NOW()')
        }, 'user-1', { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'UPDATE `users` SET `nickname` = ?, `updated_at` = NOW() WHERE `id` = ?');
        assert.deepEqual(calls[0].data, [ null, 'user-1' ]);
    });

    it('update() preserves Date bindings as parameter values', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ { affectedRows: 1 } ];
            }
        };
        const disconnectedAt = new Date('2026-05-02T03:10:43.788Z');

        await Mysql.update('workers', {
            disconnected_at: disconnectedAt,
            status: 'disconnected'
        }, 'worker-1', { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'UPDATE `workers` SET `disconnected_at` = ?, `status` = ? WHERE `id` = ?');
        assert.deepEqual(calls[0].data, [ disconnectedAt, 'disconnected', 'worker-1' ]);
    });

    it('update() throws CustomError when data is null', async () => {
        await assert.rejects(
            Mysql.update('users', null, 'user-1', { connection: { execute: async () => [ [] ] } }),
            (error) => error instanceof CustomError && error.message === 'Invalid data for update operation.',
        );
    });

    it('find() maps null filters to IS NULL', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ [] ];
            }
        };

        await Mysql.find('users', {
            filter: { deleted_at: null }
        }, { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'SELECT * FROM `users` WHERE `deleted_at` IS NULL');
        assert.deepEqual(calls[0].data, []);
    });

    it('find() supports null and non-null filters together', async () => {
        const calls = [];
        const connection = {
            async execute(sql, data) {
                calls.push({ sql, data });
                return [ [] ];
            }
        };

        await Mysql.find('users', {
            filter: {
                deleted_at: null,
                email: 'john@example.com'
            }
        }, { connection });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sql, 'SELECT * FROM `users` WHERE `deleted_at` IS NULL AND `email` = ?');
        assert.deepEqual(calls[0].data, [ 'john@example.com' ]);
    });
});
