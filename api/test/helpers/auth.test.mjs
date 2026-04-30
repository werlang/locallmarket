import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBearerApiKey } from '../../helpers/auth.js';

test('parseBearerApiKey returns token from Authorization Bearer header', () => {
    assert.equal(parseBearerApiKey({ authorization: 'Bearer abc123' }), 'abc123');
    assert.equal(parseBearerApiKey({ Authorization: 'Bearer key-xyz' }), 'key-xyz');
});

test('parseBearerApiKey rejects missing or malformed Authorization header', () => {
    assert.throws(
        () => parseBearerApiKey({}),
        /Authorization header with Bearer token is required/
    );

    assert.throws(
        () => parseBearerApiKey({ authorization: 'Token abc123' }),
        /Authorization header with Bearer token is required/
    );

    assert.throws(
        () => parseBearerApiKey({ authorization: 'Bearer   ' }),
        /Authorization header with Bearer token is required/
    );
});
