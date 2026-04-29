import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ApiStreamClient } from '../../helpers/api-client.js';

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

function createMockModelRunner() {
    return http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/engines/llama.cpp/v1/chat/completions') {
            res.statusCode = 404;
            res.end('not found');
            return;
        }

        let rawBody = '';
        for await (const chunk of req) {
            rawBody += chunk;
        }

        const parsedBody = JSON.parse(rawBody || '{}');
        const prompt = parsedBody.messages?.at(-1)?.content || 'empty';
        const holdMs = prompt.includes('slow') ? 150 : 25;
        const chunkDelayMs = prompt.includes('slow') ? 120 : 15;
        const chunks = ['Echo: ', prompt];

        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache'
        });

        const sendChunk = (content) => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        };

        setTimeout(() => {
            sendChunk(chunks[0]);

            setTimeout(() => {
                sendChunk(chunks[1]);

                setTimeout(() => {
                    res.write('data: [DONE]\n\n');
                    res.end();
                }, chunkDelayMs);
            }, chunkDelayMs);
        }, holdMs);
    });
}

function parseSse(rawBody) {
    return rawBody
        .split('\n\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const lines = entry.split('\n');
            const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
            const data = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');

            return { event, data };
        });
}

async function waitFor(check, { timeoutMs = 2000, intervalMs = 20, message = 'Condition timed out.' } = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const result = await check();
        if (result) {
            return result;
        }

        await delay(intervalMs);
    }

    throw new Error(message);
}

async function fetchReady(apiBaseUrl) {
    const response = await fetch(`${apiBaseUrl}/ready`);

    return {
        status: response.status,
        body: await response.json()
    };
}

async function openStream(apiBaseUrl, body) {
    return fetch(`${apiBaseUrl}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
}

test('API stream route relays worker output and exposes queue state through /ready', { concurrency: false }, async (t) => {
    const modelServer = createMockModelRunner();
    const workerClient = new ApiStreamClient({ workerId: 'integration-worker-1' });

    workerClient.scheduleReconnect = () => {};

    await new Promise((resolve) => {
        modelServer.listen(0, '127.0.0.1', resolve);
    });

    const modelAddress = modelServer.address();
    const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}`;

    const originalPort = process.env.PORT;
    process.env.PORT = '0';

    const apiModule = await import('../../../api/app.js');
    const { server } = apiModule;

    if (!server.listening) {
        await once(server, 'listening');
    }

    const apiAddress = server.address();
    const apiBaseUrl = `http://127.0.0.1:${apiAddress.port}`;

    workerClient.url = `ws://127.0.0.1:${apiAddress.port}/ws/workers`;
    workerClient.connect();

    t.after(async () => {
        workerClient.scheduleReconnect = () => {};
        clearTimeout(workerClient.reconnectTimer);
        workerClient.socket?.close?.();

        await closeServer(modelServer);
        await closeServer(server);

        if (originalPort === undefined) {
            delete process.env.PORT;
        } else {
            process.env.PORT = originalPort;
        }
    });

    await waitFor(async () => {
        const ready = await fetchReady(apiBaseUrl);
        return ready.body.connectedWorkers === 1 && ready.body.availableWorkers === 1 ? ready.body : null;
    }, {
        message: 'Expected the worker WebSocket client to register with the API.'
    });

    await t.test('GET /ready reports queue and worker state', async () => {
        const ready = await fetchReady(apiBaseUrl);

        assert.equal(ready.status, 200);
        assert.deepEqual(ready.body, {
            ok: true,
            connectedWorkers: 1,
            availableWorkers: 1,
            activeJobs: 0,
            queuedJobs: 0
        });
    });

    await t.test('POST /stream rejects requests that omit the documented message field', async () => {
        const response = await fetch(`${apiBaseUrl}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'ai/smollm2:135M-Q2_K' })
        });

        assert.equal(response.status, 400);

        const payload = await response.json();
        assert.equal(payload.error, true);
        assert.equal(payload.message, 'message must be a non-empty string.');
    });

    await t.test('POST /stream relays message and end SSE events from the worker socket', async () => {
        const response = await openStream(apiBaseUrl, {
            message: 'stream this prompt',
            model: 'ai/smollm2:135M-Q2_K',
            host: modelBaseUrl
        });

        assert.equal(response.status, 200);

        const events = parseSse(await response.text());
        assert.deepEqual(events, [
            { event: 'message', data: 'Echo:' },
            { event: 'message', data: 'stream this prompt' },
            { event: 'end', data: 'Stream complete.' }
        ]);

        const ready = await waitFor(async () => {
            const current = await fetchReady(apiBaseUrl);
            return current.body.availableWorkers === 1 && current.body.activeJobs === 0 ? current.body : null;
        }, {
            message: 'Expected the worker to return to the available pool after streaming.'
        });

        assert.equal(ready.queuedJobs, 0);
    });

    await t.test('GET /ready exposes queued work while the only worker is busy', async () => {
        const firstResponsePromise = openStream(apiBaseUrl, {
            message: 'slow first request',
            model: 'ai/smollm2:135M-Q2_K',
            host: modelBaseUrl
        });
        const secondResponsePromise = openStream(apiBaseUrl, {
            message: 'slow second request',
            model: 'ai/smollm2:135M-Q2_K',
            host: modelBaseUrl
        });

        const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);

        assert.equal(firstResponse.status, 200);
        assert.equal(secondResponse.status, 200);

        const queuedState = await waitFor(async () => {
            const ready = await fetchReady(apiBaseUrl);
            return ready.body.activeJobs === 1 && ready.body.queuedJobs === 1
                ? ready.body
                : null;
        }, {
            message: 'Expected one active job and one queued job while the worker is busy.'
        });

        assert.equal(queuedState.connectedWorkers, 1);
        assert.equal(queuedState.availableWorkers, 0);

        const [firstEvents, secondEvents] = await Promise.all([
            firstResponse.text().then(parseSse),
            secondResponse.text().then(parseSse)
        ]);

        assert.equal(firstEvents.at(-1)?.event, 'end');
        assert.equal(secondEvents.at(-1)?.event, 'end');

        const settledState = await waitFor(async () => {
            const ready = await fetchReady(apiBaseUrl);
            return ready.body.activeJobs === 0 && ready.body.queuedJobs === 0 && ready.body.availableWorkers === 1
                ? ready.body
                : null;
        }, {
            message: 'Expected the queue to drain after both stream requests completed.'
        });

        assert.equal(settledState.connectedWorkers, 1);
    });
});