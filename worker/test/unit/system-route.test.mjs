import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { router } from '../../routes/system.js';

function startServer(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function stopServer(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
}

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        }).on('error', reject);
    });
}

test('system route GET /ready', async (t) => {
    const app = express();
    app.use('/', router);
    const server = await startServer(app);
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    t.after(() => stopServer(server));

    await t.test('returns HTTP 200', async () => {
        const { status } = await get(`${base}/ready`);
        assert.equal(status, 200);
    });

    await t.test('response body has ok, message, timestamp, and uptime', async () => {
        const { body } = await get(`${base}/ready`);

        assert.equal(body.ok, true);
        assert.equal(body.message, 'I am ready!');

        // timestamp is a valid ISO 8601 string
        assert.ok(!isNaN(Date.parse(body.timestamp)), `Expected valid ISO timestamp, got: ${body.timestamp}`);

        // uptime is a non-negative number
        assert.equal(typeof body.uptime, 'number');
        assert.ok(body.uptime >= 0);
    });
});
