import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../helpers/error.js';
import { LLM } from '../../model/llm.js';

class CollectingStream {

    constructor() {
        this.events = [];
        this.currentEvent = 'message';
    }

    event(eventName) {
        this.currentEvent = eventName;
        return this;
    }

    send(data) {
        this.events.push({ event: this.currentEvent, data });
        return this;
    }
}

function createBody(chunks) {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
        }
    });
}

test('LLM.streamOutput forwards model chunks as message/end stream events', async () => {
    const originalFetch = global.fetch;
    const captured = [];

    global.fetch = async (url, options) => {
        captured.push({ url, body: JSON.parse(options.body) });

        return {
            ok: true,
            status: 200,
            body: createBody([
                'data: {"choices":[{"delta":{"content":"Echo: "}}]}\n',
                'data: {"choices":[{"delta":{"content":"hello world"}}]}\n',
                'data: [DONE]\n'
            ])
        };
    };

    try {
        const stream = new CollectingStream();
        const llm = new LLM({ model: 'ai/smollm2:135M-Q2_K', host: 'http://127.0.0.1:3999' });

        await llm.streamOutput('hello world', stream);

        assert.equal(captured[0].url, 'http://127.0.0.1:3999/engines/llama.cpp/v1/chat/completions');
        assert.equal(captured[0].body.model, 'ai/smollm2:135M-Q2_K');
        assert.equal(captured[0].body.messages.at(-1).content, 'hello world');
        assert.deepEqual(stream.events, [
            { event: 'message', data: 'Echo: ' },
            { event: 'message', data: 'hello world' },
            { event: 'end', data: 'Stream complete.' }
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('LLM.streamOutput wraps upstream HTTP failures in an HttpError', async () => {
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: false,
        status: 502,
        body: createBody([])
    });

    try {
        const llm = new LLM({ model: 'ai/smollm2:135M-Q2_K', host: 'http://127.0.0.1:3999' });

        await assert.rejects(
            () => llm.streamOutput('hello world', new CollectingStream()),
            (error) => error instanceof HttpError
                && error.status === 500
                && error.message === 'Model call failed with status 502'
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('LLM.streamOutput aborts and rethrows when response.ok is false with a non-502 status', async () => {
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: false,
        status: 404,
        body: createBody([])
    });

    try {
        const llm = new LLM({ model: 'ai/smollm2:135M-Q2_K', host: 'http://127.0.0.1:3999' });

        await assert.rejects(
            () => llm.streamOutput('hello world', new CollectingStream()),
            (error) => error instanceof HttpError
                && error.status === 500
                && error.message === 'Model call failed with status 404'
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('LLM.streamOutput properly concatenates partial buffer chunks across read() cycles', async () => {
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: true,
        status: 200,
        body: createBody([
            // First chunk ends mid-line — no newline yet
            'data: {"choices":[{"delta":{"cont',
            // Second chunk completes the line and adds [DONE]
            'ent":"partial"}}]}\n',
            'data: [DONE]\n'
        ])
    });

    try {
        const stream = new CollectingStream();
        const llm = new LLM({ model: 'ai/smollm2:135M-Q2_K', host: 'http://127.0.0.1:3999' });
        await llm.streamOutput('hello', stream);

        assert.deepEqual(stream.events, [
            { event: 'message', data: 'partial' },
            { event: 'end', data: 'Stream complete.' }
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('LLM.streamOutput handles a stream that sends [DONE] without prior content chunks', async () => {
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: true,
        status: 200,
        body: createBody(['data: [DONE]\n'])
    });

    try {
        const stream = new CollectingStream();
        const llm = new LLM({ model: 'ai/smollm2:135M-Q2_K', host: 'http://127.0.0.1:3999' });
        await llm.streamOutput('hello', stream);

        assert.deepEqual(stream.events, [
            { event: 'end', data: 'Stream complete.' }
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test('LLM constructor uses process.env.MODEL_RUNNER_MODEL when model is an empty string', async () => {
    const originalFetch = global.fetch;
    const originalModel = process.env.MODEL_RUNNER_MODEL;
    process.env.MODEL_RUNNER_MODEL = 'env-fallback-model';

    const captured = [];
    global.fetch = async (url, options) => {
        captured.push(JSON.parse(options.body));
        return {
            ok: true,
            status: 200,
            body: createBody(['data: [DONE]\n'])
        };
    };

    try {
        const llm = new LLM({ model: '', host: 'http://127.0.0.1:3999' });
        await llm.streamOutput('hello', new CollectingStream());

        assert.equal(captured[0].model, 'env-fallback-model');
    } finally {
        global.fetch = originalFetch;
        if (originalModel === undefined) {
            delete process.env.MODEL_RUNNER_MODEL;
        } else {
            process.env.MODEL_RUNNER_MODEL = originalModel;
        }
    }
});