import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorMiddleware } from '../../middleware/error.js';
import { HttpError } from '../../helpers/error.js';

function makeRes() {
    const res = {
        _status: null,
        _body: null,
        status(code) {
            this._status = code;
            return this;
        },
        json(body) {
            this._body = body;
            return this;
        }
    };
    return res;
}

function makeReq() {
    return {};
}

describe('errorMiddleware', () => {
    it('maps an HttpError with a known status to the correct JSON envelope', () => {
        const err = new HttpError(400, 'Bad input');
        const res = makeRes();
        let nextCalled = false;
        errorMiddleware(err, makeReq(), res, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(res._status, 400);
        assert.deepEqual(res._body, {
            error: true,
            status: 400,
            type: 'Bad Request',
            message: 'Bad input',
        });
    });

    it('maps a generic Error to status 500', () => {
        const err = new Error('explosion');
        const res = makeRes();
        errorMiddleware(err, makeReq(), res, () => {});
        assert.equal(res._status, 500);
        assert.equal(res._body.error, true);
        assert.equal(res._body.status, 500);
    });

    it('includes data in non-production mode', () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        try {
            const err = new Error('with data');
            err.data = { hint: 'check logs' };
            const res = makeRes();
            errorMiddleware(err, makeReq(), res, () => {});
            assert.deepEqual(res._body.data, { hint: 'check logs' });
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    it('omits data in production mode', () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const err = new Error('with data');
            err.data = { secret: 'internal' };
            const res = makeRes();
            errorMiddleware(err, makeReq(), res, () => {});
            assert.equal(Object.hasOwn(res._body, 'data'), false);
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    it('maps an unknown status to 500', () => {
        const err = new Error('weird');
        err.status = 999;
        const res = makeRes();
        errorMiddleware(err, makeReq(), res, () => {});
        assert.equal(res._status, 500);
        assert.equal(res._body.status, 500);
    });

    it('calls next() when no error is provided', () => {
        const res = makeRes();
        let nextCalled = false;
        errorMiddleware(null, makeReq(), res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(res._status, null);
    });
});
