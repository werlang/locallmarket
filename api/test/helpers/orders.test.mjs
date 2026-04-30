import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseLegacyStreamBody,
    parseUseWorkerBody
} from '../../helpers/orders.js';

test('parseUseWorkerBody supports message and input aliases', () => {
    assert.deepEqual(parseUseWorkerBody({ message: ' hi ' }), { message: 'hi' });
    assert.deepEqual(parseUseWorkerBody({ input: ' hello ' }), { message: 'hello' });

    assert.throws(() => parseUseWorkerBody({}), /message must be a non-empty string/);
});

test('parseLegacyStreamBody validates model and normalizes message payload', () => {
    assert.deepEqual(parseLegacyStreamBody({ message: ' hi ', model: ' llama3 ' }), {
        message: 'hi',
        model: 'llama3'
    });

    assert.deepEqual(parseLegacyStreamBody({ input: ' hello ', model: ' gpt-oss ' }), {
        message: 'hello',
        model: 'gpt-oss'
    });

    assert.throws(() => parseLegacyStreamBody({ message: 'hi' }), /model is required in the request body/);
});
