---
name: api-testing
description: Write and run tests for the API and Worker services using Node.js built-in node:test. Use when adding new tests, extending coverage, fixing failing tests, or choosing between unit and integration test strategies.
---

# API Testing

## Test Framework

- **Runner**: Node.js built-in `node:test` (no Jest, no Mocha, no external test runner)
- **Assertions**: `node:assert/strict`
- **Test files**: `.mjs` extension, ESM imports
- **No setup files**: each test file is a self-contained Node.js process

## Commands

```bash
# Run all tests (unit + integration)
cd api && npm test
cd worker && npm test

# Unit tests only
cd api && npm run test:unit
cd worker && npm run test:unit

# Integration tests only
cd api && npm run test:integration
cd worker && npm run test:integration
```

## Test Locations

```
api/test/
  unit/
    error.test.mjs        — HttpError, CustomError
    queue.test.mjs        — Queue add/shift/remove/requeue/getPosition/getSize
    middleware-error.test.mjs — errorMiddleware envelope shape
    stream.test.mjs       — HttpStream SSE headers, event/send/close
    wsserver.test.mjs     — WSServer message routing, send, broadcast
    router.test.mjs       — StreamRouter dispatch, cancel, worker lifecycle
  integration/
    api-routes.test.mjs   — real HTTP: GET /ready, POST /stream validation, 404

worker/test/
  unit/
    error.test.mjs        — HttpError, CustomError
    api-client.test.mjs   — ApiStreamClient connect/disconnect, sendReady, handleMessage
    llm.test.mjs          — LLM streamOutput (fetch mock)
    middleware-error.test.mjs — errorMiddleware
    system-route.test.mjs — GET /ready response shape
    stream-router-reconnect.test.mjs — StreamRouter reconnect (pre-existing)
  integration/
    stream-api.test.mjs   — end-to-end SSE relay with real API server
```

## File Structure

```js
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('MyModule', () => {
  it('does something', () => {
    assert.equal(actual, expected);
  });
});
```

## Unit Test Patterns

### Fake sockets (for WSServer and StreamRouter tests)

```js
function makeFakeSocket(overrides = {}) {
  const handlers = {};
  return {
    readyState: 1, // WebSocket.OPEN
    send: mock.fn(),
    terminate: mock.fn(),
    on(event, fn) { handlers[event] = fn; },
    emit(event, ...args) { handlers[event]?.(...args); },
    ...overrides
  };
}
```

### Fake HTTP response (for HttpStream tests)

```js
function makeFakeRes(overrides = {}) {
  let statusCode = 200;
  const headers = {};
  const written = [];
  return {
    writableEnded: false,
    status(code) { statusCode = code; return this; },
    setHeader(k, v) { headers[k] = v; },
    flushHeaders: mock.fn(),
    write(chunk) { written.push(chunk); },
    end() { this.writableEnded = true; },
    _headers: headers,
    _written: written,
    ...overrides
  };
}
```

### Mock fetch (for LLM tests)

Use `mock.method` on `globalThis` or pass a custom `fetch` option if the class accepts it:

```js
import { mock } from 'node:test';

// Stub global fetch for an SSE-style streaming response
const encoder = new TextEncoder();
mock.method(globalThis, 'fetch', async () => ({
  ok: true,
  body: {
    getReader: () => {
      let done = false;
      return {
        async read() {
          if (done) return { done: true };
          done = true;
          return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n') };
        }
      };
    }
  }
}));
```

### Lifecycle hooks

```js
import { before, after, beforeEach, afterEach } from 'node:test';

before(async () => { /* setup once */ });
after(async () => { /* teardown once */ });
beforeEach(() => { /* reset mocks */ });
afterEach(() => { /* cleanup */ });
```

### Real WebSocket server in tests

```js
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { WSServer } from '../../helpers/wsserver.js';

let wss, port;

before(async () => {
  wss = new WSServer({ port: 0, path: '/ws/test' });  // port 0 = OS-assigned
  if (!wss.ws.address()) await once(wss.ws, 'listening');
  port = wss.ws.address().port;
});

after(async () => {
  for (const client of wss.ws.clients) client.terminate();
  await new Promise(resolve => wss.ws.close(resolve));
});
```

### Integration tests — dynamic port to avoid conflicts

```js
// Set env vars BEFORE importing app.js so the server binds to port 0
process.env.PORT = '0';
process.env.API_WS_PORT = '0';

const { server } = await import('../../app.js');
// wait for server to be listening
const address = server.address();
const port = address.port;
```

## Coverage Checklist

When adding new behavior, add tests for:

- [ ] Happy path (valid input → expected output/response)
- [ ] Validation failures (missing/invalid fields → correct error code and message)
- [ ] Edge cases (empty queue, no workers, duplicate registration, client disconnect mid-stream)
- [ ] Error propagation (thrown errors reach middleware with correct status and shape)
- [ ] Cleanup / idempotency (double-close, double-cancel, reconnect after disconnect)

## Scope by Module

| Module | What to assert |
|---|---|
| `Queue` | add/shift sequence, requeue order, remove by id, getPosition (1-based), getSize |
| `HttpStream` | response headers set on construction, `event()`/`send()` writes correct SSE lines, `close()` ends response exactly once, `closed` getter |
| `WSServer` | registered handler called with correct args, unknown type ignored, send formats JSON, broadcast reaches all OPEN clients |
| `StreamRouter` | enqueue dispatches to available worker, cancel removes from queue, disconnected client flagged, worker lifecycle (register→ready→dispatch→complete/fail) |
| `HttpError` / `CustomError` | message, status, name set correctly |
| `errorMiddleware` | envelope shape `{ error, status, type, message }`, `data.detail` hidden in production, 500 fallback for unknown errors |
| `GET /ready` | returns `ok: true` with queue/worker counts |
| `POST /stream` | 400 for missing message/model, SSE headers on valid request |
| `ApiStreamClient` | sends `worker-register` on open, `worker-ready` after job, handles `job-dispatch` message, schedules reconnect on close |
| `LLM` | parses SSE chunks, sends `end` event on `[DONE]`, wraps errors as `HttpError` |

## Done Criteria

- All test files use `node:test` + `node:assert/strict` (no Jest APIs).
- Tests run with `npm run test:unit` / `npm run test:integration` in each service directory.
- Both happy paths and error/edge cases are covered for any modified behavior.
- Any untested behavior is explicitly noted in the task handoff.
