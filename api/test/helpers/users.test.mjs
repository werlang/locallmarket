import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCreateUserBody,
    parseExternalId,
    parseListUsersQuery,
    parseRechargeBody,
    parseUpdateUserBody
} from '../../helpers/users.js';

test('parseCreateUserBody validates and normalizes fields', () => {
    const payload = parseCreateUserBody({
        externalId: '  user-1  ',
        name: '  Alice  ',
        email: '  ALICE@example.com  '
    });

    assert.deepEqual(payload, {
        externalId: 'user-1',
        name: 'Alice',
        email: 'alice@example.com'
    });
});

test('parseExternalId rejects missing externalId', () => {
    assert.throws(() => parseExternalId('   '), /externalId must be a non-empty string/);
});

test('parseUpdateUserBody requires at least one mutable field', () => {
    assert.throws(() => parseUpdateUserBody({}), /At least one field must be provided/);
});

test('parseUpdateUserBody validates email', () => {
    assert.throws(() => parseUpdateUserBody({ email: 'not-an-email' }), /valid email/);
});

test('parseRechargeBody accepts positive amount only', () => {
    assert.equal(parseRechargeBody({ amount: '10.5' }), 10.5);
    assert.throws(() => parseRechargeBody({ amount: 0 }), /positive number/);
});

test('parseListUsersQuery applies defaults and validates values', () => {
    assert.deepEqual(parseListUsersQuery({}), { limit: 100, offset: 0 });
    assert.deepEqual(parseListUsersQuery({ limit: '10', offset: '2' }), { limit: 10, offset: 2 });
    assert.throws(() => parseListUsersQuery({ limit: 0 }), /limit must be a positive integer/);
    assert.throws(() => parseListUsersQuery({ offset: -1 }), /offset must be a non-negative integer/);
});

test('parseCreateUserBody rejects missing externalId', () => {
    assert.throws(() => parseCreateUserBody({}), /externalId must be a non-empty string/);
    assert.throws(() => parseCreateUserBody({ externalId: '   ' }), /externalId must be a non-empty string/);
});

test('parseCreateUserBody rejects invalid email', () => {
    assert.throws(
        () => parseCreateUserBody({ externalId: 'u1', email: 'not-an-email' }),
        /valid email/
    );
});

test('parseCreateUserBody trims and lowercases email', () => {
    const result = parseCreateUserBody({ externalId: 'u1', email: '  Bob@Example.COM  ' });
    assert.equal(result.email, 'bob@example.com');
    assert.equal(result.externalId, 'u1');
});

test('parseUpdateUserBody rejects empty name string', () => {
    assert.throws(
        () => parseUpdateUserBody({ name: '   ' }),
        /non-empty string/
    );
});
