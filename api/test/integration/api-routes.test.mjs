import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';

// Must be set before app.js is imported so Express and WSServer bind to
// OS-assigned ports instead of hardcoded defaults.
process.env.PORT = '0';
process.env.API_WS_PORT = '0';

let app, server, streamRouter;

before(async () => {
    ({ app, server, streamRouter } = await import('../../app.js'));
    if (!server.listening) {
        await once(server, 'listening');
    }
});

after(async () => {
    // Close the WebSocket server that app.js opens for worker connections
    if (streamRouter.wsServer?.ws) {
        for (const client of streamRouter.wsServer.ws.clients) {
            client.terminate();
        }
        await new Promise((resolve) => streamRouter.wsServer.ws.close(resolve));
    }
    await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
});

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let parsed;
                try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed, raw });
            });
        });
        req.on('error', reject);
        if (body !== undefined) {
            const data = typeof body === 'string' ? body : JSON.stringify(body);
            req.write(data);
        }
        req.end();
    });
}

function getPort() {
    return server.address().port;
}

describe('API integration', () => {
    it('GET /ready → 200 with state envelope', async () => {
        const res = await request({
            hostname: '127.0.0.1',
            port: getPort(),
            path: '/ready',
            method: 'GET'
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, {
            ok: true,
            connectedWorkers: 0,
            availableWorkers: 0,
            activeJobs: 0,
            queuedJobs: 0
        });
    });

    it('POST /stream with no body → 400 error envelope', async () => {
        const res = await request({
            hostname: '127.0.0.1',
            port: getPort(),
            path: '/stream',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, '{}');
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, true);
        assert.equal(res.body.status, 400);
    });

    it('POST /stream with missing message → 400 with correct message', async () => {
        const res = await request({
            hostname: '127.0.0.1',
            port: getPort(),
            path: '/stream',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ model: 'test-model' }));
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, true);
        assert.ok(res.body.message.includes('message must be a non-empty string'));
    });

    it('POST /stream with missing model → 400 with correct message', async () => {
        const res = await request({
            hostname: '127.0.0.1',
            port: getPort(),
            path: '/stream',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, JSON.stringify({ message: 'hello' }));
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, true);
        assert.ok(res.body.message.includes('model is required'));
    });

    it('GET /nonexistent → 404 error envelope', async () => {
        const res = await request({
            hostname: '127.0.0.1',
            port: getPort(),
            path: '/nonexistent-path',
            method: 'GET'
        });
        assert.equal(res.statusCode, 404);
        assert.equal(res.body.error, true);
        assert.equal(res.body.status, 404);
    });

    it('POST /stream with valid payload and no workers → opens SSE stream (status 200)', async () => {
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: getPort(),
                path: '/stream',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                try {
                    assert.equal(res.statusCode, 200);
                    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
                } catch (err) {
                    res.destroy();
                    reject(err);
                    return;
                }
                // Destroy immediately — we only need to confirm headers
                res.destroy();
                resolve();
            });
            req.on('error', (err) => {
                // ECONNRESET is expected when we destroy the response
                if (err.code === 'ECONNRESET') resolve();
                else reject(err);
            });
            req.write(JSON.stringify({ message: 'hello', model: 'test-model' }));
            req.end();
        });
    });
});
