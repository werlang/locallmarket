import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpStream } from '../../helpers/stream.js';

function makeRes() {
    return {
        _status: null,
        _headers: {},
        _written: [],
        _ended: false,
        _flushed: false,
        writableEnded: false,
        status(code) {
            this._status = code;
            return this;
        },
        setHeader(name, value) {
            this._headers[name] = value;
        },
        flushHeaders() {
            this._flushed = true;
        },
        write(chunk) {
            this._written.push(chunk);
        },
        end() {
            this._ended = true;
            this.writableEnded = true;
        }
    };
}

describe('HttpStream', () => {
    it('constructor sets Content-Type to text/event-stream', () => {
        const res = makeRes();
        new HttpStream(res);
        assert.ok(res._headers['Content-Type'].includes('text/event-stream'));
    });

    it('constructor sets Cache-Control to no-cache', () => {
        const res = makeRes();
        new HttpStream(res);
        assert.ok(res._headers['Cache-Control'].includes('no-cache'));
    });

    it('constructor calls res.flushHeaders() when available', () => {
        const res = makeRes();
        new HttpStream(res);
        assert.equal(res._flushed, true);
    });

    it('constructor does not throw when flushHeaders is absent', () => {
        const res = makeRes();
        delete res.flushHeaders;
        assert.doesNotThrow(() => new HttpStream(res));
    });

    it('constructor calls res.status(200)', () => {
        const res = makeRes();
        new HttpStream(res);
        assert.equal(res._status, 200);
    });

    it('event() returns this for chaining', () => {
        const res = makeRes();
        const stream = new HttpStream(res);
        assert.equal(stream.event('data'), stream);
    });

    it('send() writes event: X\\ndata: Y\\n\\n format', () => {
        const res = makeRes();
        const stream = new HttpStream(res);
        stream.event('message').send('hello');
        assert.equal(res._written[0], 'event: message\n');
        assert.equal(res._written[1], 'data: hello\n\n');
    });

    it('send() is a no-op when closed is true', () => {
        const res = makeRes();
        const stream = new HttpStream(res);
        stream.close();
        const countBefore = res._written.length;
        stream.send('ignored');
        assert.equal(res._written.length, countBefore);
    });

    it('close() sets closed to true and calls res.end()', () => {
        const res = makeRes();
        const stream = new HttpStream(res);
        assert.equal(stream.closed, false);
        stream.close();
        assert.equal(stream.closed, true);
        assert.equal(res._ended, true);
    });

    it('close() is idempotent — res.end() called only once', () => {
        const res = makeRes();
        let endCallCount = 0;
        res.end = () => {
            endCallCount++;
            res._ended = true;
            res.writableEnded = true;
        };
        const stream = new HttpStream(res);
        stream.close();
        stream.close();
        assert.equal(endCallCount, 1);
    });
});
