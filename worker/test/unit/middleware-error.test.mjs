import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../helpers/error.js';
import { errorMiddleware } from '../../middleware/error.js';

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
        }
    };
    return res;
}

test('errorMiddleware', async (t) => {
    await t.test('returns correct JSON envelope for an HttpError', () => {
        const err = new HttpError(404, 'Not Found');
        const res = makeRes();
        errorMiddleware(err, {}, res, () => {});

        assert.equal(res._status, 404);
        assert.deepEqual(res._body, {
            error: true,
            status: 404,
            type: 'Not Found',
            message: 'Not Found',
        });
    });

    await t.test('defaults status to 500 for a generic Error', () => {
        const err = new Error('something broke');
        const res = makeRes();
        errorMiddleware(err, {}, res, () => {});

        assert.equal(res._status, 500);
        assert.equal(res._body.status, 500);
        assert.equal(res._body.error, true);
    });

    await t.test('includes data when NODE_ENV is not production', () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';

        try {
            const err = new HttpError(400, 'Bad Request', { field: 'name' });
            const res = makeRes();
            errorMiddleware(err, {}, res, () => {});

            assert.deepEqual(res._body.data, { field: 'name' });
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    await t.test('omits data when NODE_ENV is production', () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        try {
            const err = new HttpError(400, 'Bad Request', { field: 'name' });
            const res = makeRes();
            errorMiddleware(err, {}, res, () => {});

            assert.equal('data' in res._body, false);
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    await t.test('maps unmapped status codes (e.g. 999) to 500', () => {
        const err = { status: 999, message: 'custom' };
        const res = makeRes();
        errorMiddleware(err, {}, res, () => {});

        assert.equal(res._status, 500);
        assert.equal(res._body.status, 500);
    });

    await t.test('calls next() when no error is passed', () => {
        let called = false;
        errorMiddleware(null, {}, makeRes(), () => { called = true; });
        assert.ok(called);
    });
});
