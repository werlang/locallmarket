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

    it('update() throws CustomError when data is null', async () => {
        await assert.rejects(
            Mysql.update('users', null, 'user-1', { connection: { execute: async () => [ [] ] } }),
            (error) => error instanceof CustomError && error.message === 'Invalid data for update operation.',
        );
    });
});
