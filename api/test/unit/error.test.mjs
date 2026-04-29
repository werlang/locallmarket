import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CustomError, HttpError } from '../../helpers/error.js';

describe('CustomError', () => {
    it('is an instance of Error', () => {
        const err = new CustomError('oops');
        assert.ok(err instanceof Error);
    });

    it('has name CustomError', () => {
        const err = new CustomError('oops');
        assert.equal(err.name, 'CustomError');
    });

    it('stores the message', () => {
        const err = new CustomError('something broke');
        assert.equal(err.message, 'something broke');
    });

    it('defaults message to Internal Server Error', () => {
        const err = new CustomError();
        assert.equal(err.message, 'Internal Server Error');
    });

    it('stores data', () => {
        const err = new CustomError('oops', { field: 'x' });
        assert.deepEqual(err.data, { field: 'x' });
    });

    it('defaults data to null', () => {
        const err = new CustomError('oops');
        assert.equal(err.data, null);
    });
});

describe('HttpError', () => {
    it('is an instance of CustomError', () => {
        const err = new HttpError(400, 'Bad');
        assert.ok(err instanceof CustomError);
    });

    it('is an instance of Error', () => {
        const err = new HttpError(400, 'Bad');
        assert.ok(err instanceof Error);
    });

    it('has name HttpError', () => {
        const err = new HttpError(400, 'Bad');
        assert.equal(err.name, 'HttpError');
    });

    it('stores integer status', () => {
        const err = new HttpError(404, 'Not Found');
        assert.equal(err.status, 404);
    });

    it('sets code equal to status', () => {
        const err = new HttpError(404, 'Not Found');
        assert.equal(err.code, 404);
    });

    it('sets expose to true', () => {
        const err = new HttpError(400, 'Bad');
        assert.equal(err.expose, true);
    });

    it('sets type to null', () => {
        const err = new HttpError(400, 'Bad');
        assert.equal(err.type, null);
    });

    it('stores the message', () => {
        const err = new HttpError(500, 'Broken');
        assert.equal(err.message, 'Broken');
    });

    it('defaults to status 500 with no args', () => {
        const err = new HttpError();
        assert.equal(err.status, 500);
    });

    it('defaults message to Internal Server Error with no args', () => {
        const err = new HttpError();
        assert.equal(err.message, 'Internal Server Error');
    });

    it('defaults status to 500 for a non-numeric string', () => {
        const err = new HttpError('abc', 'Bad');
        assert.equal(err.status, 500);
    });

    it('defaults status to 500 for a float', () => {
        const err = new HttpError(3.5, 'Bad');
        assert.equal(err.status, 500);
    });
});
