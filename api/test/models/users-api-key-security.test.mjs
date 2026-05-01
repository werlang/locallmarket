import test from 'node:test';
import assert from 'node:assert/strict';

import { Mysql } from '../../helpers/mysql.js';
import { UsersModel } from '../../models/users.js';
import {
    computeApiKeyLookupHash,
    decryptApiKey
} from '../../helpers/secure-key.js';

const mysqlOriginals = {
    findOne: Mysql.findOne,
    insert: Mysql.insert
};

const originalApiKeyEncryptionSecret = process.env.API_KEY_ENCRYPTION_SECRET;

test.before(() => {
    process.env.API_KEY_ENCRYPTION_SECRET = 'test-api-key-encryption-secret';
});

test.after(() => {
    process.env.API_KEY_ENCRYPTION_SECRET = originalApiKeyEncryptionSecret;
});

test.afterEach(() => {
    Mysql.findOne = mysqlOriginals.findOne;
    Mysql.insert = mysqlOriginals.insert;
});

test('register stores encrypted api key and lookup hash', async () => {
    const model = new UsersModel();
    let insertedRecord = null;

    Mysql.insert = async (_table, record) => {
        insertedRecord = record;
        return [{ affectedRows: 1 }];
    };
    Mysql.findOne = async (_table, { filter }) => {
        if (!filter.id) {
            return null;
        }

        return {
            id: filter.id,
            name: 'Alice',
            email: 'alice@example.com',
            credits: 0,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
    };

    const { apiKey } = await model.register({ name: 'Alice', email: 'alice@example.com' });

    assert.equal(typeof insertedRecord.api_key_ciphertext, 'string');
    assert.notEqual(insertedRecord.api_key_ciphertext, apiKey);
    assert.equal(insertedRecord.api_key_lookup_hash, computeApiKeyLookupHash(apiKey));
    assert.equal(decryptApiKey(insertedRecord.api_key_ciphertext), apiKey);
});

test('getByApiKeyOrNull queries by lookup hash instead of plaintext api key', async () => {
    const model = new UsersModel();
    let receivedFilter = null;

    Mysql.findOne = async (_table, options) => {
        receivedFilter = options.filter;
        return {
            id: 'uuid-auth',
            name: 'Auth User',
            email: 'auth@example.com',
            credits: 9,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z'
        };
    };

    await model.getByApiKeyOrNull('live-api-key');

    assert.deepEqual(receivedFilter, {
        api_key_lookup_hash: computeApiKeyLookupHash('live-api-key')
    });
});