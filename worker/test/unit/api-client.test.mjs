import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket } from 'ws';
import { ApiStreamClient } from '../../helpers/api-client.js';

/**
 * Minimal fake WebSocket that records sent messages.
 */
class FakeSocket {
    constructor() {
        this.readyState = WebSocket.OPEN;
        this.sent = [];
    }

    send(message) {
        this.sent.push(JSON.parse(message));
    }
}

test('ApiStreamClient constructor', async (t) => {
    await t.test('sets default url and generates a workerId when none given', () => {
        const client = new ApiStreamClient();
        assert.equal(client.url, 'ws://127.0.0.1:3000/ws/workers');
        assert.equal(typeof client.workerId, 'string');
        assert.ok(client.workerId.length > 0);
    });

    await t.test('uses the provided workerId', () => {
        const client = new ApiStreamClient({ workerId: 'my-worker-1' });
        assert.equal(client.workerId, 'my-worker-1');
    });
});

test('ApiStreamClient.sendToSocket', async (t) => {
    await t.test('sends correct JSON { type, payload } to the socket', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();

        const result = client.sendToSocket(socket, 'worker-register', { workerId: 'w1' });

        assert.equal(result, true);
        assert.equal(socket.sent.length, 1);
        assert.deepEqual(socket.sent[0], {
            type: 'worker-register',
            payload: { workerId: 'w1' }
        });
    });

    await t.test('returns false and does not send when socket is not open', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        socket.readyState = WebSocket.CLOSED;

        const result = client.sendToSocket(socket, 'ping', {});

        assert.equal(result, false);
        assert.equal(socket.sent.length, 0);
    });
});

test('ApiStreamClient.sendReady', async (t) => {
    await t.test('sends worker-ready message when not busy', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        client.socket = socket;
        client.busy = false;

        const result = client.sendReady();

        assert.equal(result, true);
        assert.equal(socket.sent.length, 1);
        assert.deepEqual(socket.sent[0], {
            type: 'worker-ready',
            payload: { workerId: 'w1' }
        });
    });

    await t.test('does not send when busy is true', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        client.socket = socket;
        client.busy = true;

        const result = client.sendReady();

        assert.equal(result, false);
        assert.equal(socket.sent.length, 0);
    });
});

test('ApiStreamClient.handleMessage', async (t) => {
    await t.test('calls processJob for stream-job type', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const captured = [];
        client.processJob = (payload) => captured.push(payload);

        client.handleMessage(JSON.stringify({ type: 'stream-job', payload: { jobId: 'j1' } }));

        assert.equal(captured.length, 1);
        assert.deepEqual(captured[0], { jobId: 'j1' });
    });

    await t.test('calls sendReady for worker-ready-request type when not busy', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        client.socket = socket;
        client.busy = false;

        client.handleMessage(JSON.stringify({ type: 'worker-ready-request', payload: {} }));

        assert.equal(socket.sent.length, 1);
        assert.equal(socket.sent[0].type, 'worker-ready');
    });

    await t.test('does not call sendReady for worker-ready-request when busy', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        client.socket = socket;
        client.busy = true;

        client.handleMessage(JSON.stringify({ type: 'worker-ready-request', payload: {} }));

        assert.equal(socket.sent.length, 0);
    });

    await t.test('ignores unknown message types', () => {
        const client = new ApiStreamClient({ workerId: 'w1', apiKey: 'test-api-key' });
        const socket = new FakeSocket();
        client.socket = socket;
        let processJobCalled = false;
        client.processJob = () => { processJobCalled = true; };

        client.handleMessage(JSON.stringify({ type: 'unknown-type', payload: {} }));

        assert.equal(socket.sent.length, 0);
        assert.equal(processJobCalled, false);
    });
});
