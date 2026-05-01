import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeApiKeyLookupHash,
    createApiKeyRecord,
    decryptApiKey,
    encryptApiKey
} from '../../helpers/secure-key.js';

const originalApiKeyEncryptionSecret = process.env.API_KEY_ENCRYPTION_SECRET;

test.before(() => {
    process.env.API_KEY_ENCRYPTION_SECRET = 'test-api-key-encryption-secret-for-helper';
});

test.after(() => {
    process.env.API_KEY_ENCRYPTION_SECRET = originalApiKeyEncryptionSecret;
});

test('encryptApiKey uses authenticated encryption and decrypts back to the original value', () => {
    const apiKey = 'a'.repeat(64);
    const encrypted = encryptApiKey(apiKey);

    assert.notEqual(encrypted, apiKey);
    assert.match(encrypted, /^v1:/);
    assert.equal(decryptApiKey(encrypted), apiKey);
});

test('createApiKeyRecord generates a stable lookup hash for the same api key', () => {
    const apiKey = 'b'.repeat(64);
    const record = createApiKeyRecord(apiKey);

    assert.equal(record.api_key_lookup_hash, computeApiKeyLookupHash(apiKey));
    assert.equal(decryptApiKey(record.api_key_ciphertext), apiKey);
});