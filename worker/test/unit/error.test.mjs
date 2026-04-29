import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomError, HttpError } from '../../helpers/error.js';

test('CustomError', async (t) => {
    await t.test('is instanceof Error', () => {
        const err = new CustomError('oops', { detail: 1 });
        assert.ok(err instanceof Error);
    });

    await t.test('has correct name, message, and data', () => {
        const err = new CustomError('something went wrong', { hint: 'check logs' });
        assert.equal(err.name, 'CustomError');
        assert.equal(err.message, 'something went wrong');
        assert.deepEqual(err.data, { hint: 'check logs' });
    });

    await t.test('uses defaults when constructed with no args', () => {
        const err = new CustomError();
        assert.equal(err.message, 'Internal Server Error');
        assert.equal(err.data, null);
    });
});

test('HttpError', async (t) => {
    await t.test('is instanceof CustomError', () => {
        const err = new HttpError(400, 'Bad Request');
        assert.ok(err instanceof CustomError);
    });

    await t.test('has correct status, code, expose, and null type', () => {
        const err = new HttpError(404, 'Not Found', { resource: 'user' });
        assert.equal(err.name, 'HttpError');
        assert.equal(err.status, 404);
        assert.equal(err.code, 404);
        assert.equal(err.expose, true);
        assert.equal(err.type, null);
        assert.deepEqual(err.data, { resource: 'user' });
    });

    await t.test('defaults status to 500 when given an invalid status', () => {
        const err = new HttpError('not-a-number', 'oops');
        assert.equal(err.status, 500);
        assert.equal(err.code, 500);
    });

    await t.test('uses defaults when constructed with no args', () => {
        const err = new HttpError();
        assert.equal(err.status, 500);
        assert.equal(err.message, 'Internal Server Error');
        assert.equal(err.data, null);
    });
});
