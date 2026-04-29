import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { WSServer } from '../../helpers/wsserver.js';

let wss;
let port;

before(async () => {
    wss = new WSServer({ port: 0, path: '/ws/test' });
    if (!wss.ws.address()) {
        await once(wss.ws, 'listening');
    }
    port = wss.ws.address().port;
});

after(async () => {
    for (const client of wss.ws.clients) {
        client.terminate();
    }
    await new Promise((resolve) => wss.ws.close(resolve));
});

function connectClient() {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/test`);
    return new Promise((resolve, reject) => {
        client.once('open', () => resolve(client));
        client.once('error', reject);
    });
}

describe('WSServer', () => {
    it('routes a known message type to the registered handler', async () => {
        const client = await connectClient();
        try {
            let received;
            wss.on('ping', (ws, payload) => { received = payload; });

            client.send(JSON.stringify({ type: 'ping', payload: { x: 1 } }));
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.deepEqual(received, { x: 1 });
        } finally {
            client.terminate();
        }
    });

    it('silently ignores messages with an unknown type', async () => {
        const client = await connectClient();
        try {
            let handlerCalled = false;
            wss.on('known-type', () => { handlerCalled = true; });

            client.send(JSON.stringify({ type: 'unknown-xyz', payload: {} }));
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.equal(handlerCalled, false);
        } finally {
            client.terminate();
        }
    });

    it('silently ignores invalid JSON', async () => {
        const client = await connectClient();
        try {
            client.send('not-json{{{');
            // Should not throw; just wait a tick
            await new Promise(resolve => setTimeout(resolve, 50));
        } finally {
            client.terminate();
        }
    });

    it('broadcast() sends message to all connected clients', async () => {
        const clientA = await connectClient();
        const clientB = await connectClient();
        try {
            const messagesA = [];
            const messagesB = [];
            clientA.on('message', (data) => messagesA.push(JSON.parse(data)));
            clientB.on('message', (data) => messagesB.push(JSON.parse(data)));

            wss.broadcast('hello', { from: 'server' });
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.equal(messagesA.length, 1);
            assert.deepEqual(messagesA[0], { type: 'hello', payload: { from: 'server' } });
            assert.equal(messagesB.length, 1);
            assert.deepEqual(messagesB[0], { type: 'hello', payload: { from: 'server' } });
        } finally {
            clientA.terminate();
            clientB.terminate();
        }
    });

    it('send() delivers message to the target socket only', async () => {
        const clientA = await connectClient();
        const clientB = await connectClient();
        try {
            const messagesA = [];
            const messagesB = [];
            clientA.on('message', (data) => messagesA.push(JSON.parse(data)));
            clientB.on('message', (data) => messagesB.push(JSON.parse(data)));

            // Find the server-side socket corresponding to clientA.
            // We identify it by sending a typed message from clientA and catching it.
            let targetSocket;
            const original = wss.methodList.get('identify');
            wss.on('identify', (ws) => { targetSocket = ws; });
            clientA.send(JSON.stringify({ type: 'identify', payload: {} }));
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.ok(targetSocket, 'Server-side socket for clientA not found');

            wss.send(targetSocket, 'direct', { msg: 'only-A' });
            await new Promise(resolve => setTimeout(resolve, 50));

            assert.equal(messagesA.length, 1);
            assert.deepEqual(messagesA[0], { type: 'direct', payload: { msg: 'only-A' } });
            assert.equal(messagesB.length, 0);

            if (original) wss.on('identify', original);
        } finally {
            clientA.terminate();
            clientB.terminate();
        }
    });
});
