---
name: api-testing
description: Write and run tests for the API and Worker services using Node.js built-in node:test. Use when adding new tests, extending coverage, fixing failing tests, choosing between unit and integration test strategies, or reviewing test gaps identified in audits.
---

# API Testing

## Test Framework & Commands

- **Runner**: Node.js built-in `node:test` (no Jest, no Mocha, no external test runner)
- **Assertions**: `node:assert/strict`
- **Test files**: `.mjs` extension, ESM imports
- **Each test file** is a self-contained Node.js process; no shared setup files

```bash
# All tests
cd api && npm test
cd worker && npm test

# Unit only
cd api && npm run test:unit
cd worker && npm run test:unit

# Integration only
cd api && npm run test:integration
cd worker && npm run test:integration
```

## Test File Inventory (27 total)

### API Tests (20 files)

**Unit (9 files):**
- `api/test/unit/error.test.mjs` — `HttpError` & `CustomError` construction, message, status, expose flag
- `api/test/unit/middleware-error.test.mjs` — error middleware envelope shape, status derivation, error hiding
- `api/test/unit/queue.test.mjs` — `Queue` add/shift/remove/requeue/getPosition/getSize sequence
- `api/test/unit/stream.test.mjs` — `HttpStream` headers, event(), send(), close(), closed getter
- `api/test/unit/wsserver.test.mjs` — `WSServer` connection, message routing, send, broadcast
- `api/test/unit/router.test.mjs` — `StreamRouter` enqueue, dispatch, cancel, worker lifecycle (register→ready→dispatch→complete/fail)
- `api/test/unit/mysql.test.mjs` — Mysql driver upsert, find, insert, delete operations
- `api/test/helpers/auth.test.mjs` — `parseBearerApiKey` validation and error handling
- `api/test/helpers/secure-key.test.mjs` — API key encryption/decryption (AES-256-GCM)

**Models (5 files):**
- `api/test/models/users.test.mjs` — `UsersModel` register, getByApiKey, rechargeById, resetApiKeyById, deleteById
- `api/test/models/users-api-key-security.test.mjs` — API key encryption correctness, digest indexing
- `api/test/models/workers.test.mjs` — `WorkersModel` bindConnectedWorker, listPoolByOwner, listPublic, findFirstAvailableByModel, markBusy
- `api/test/models/orders.test.mjs` — `OrdersModel` createReceipt, settleCompletedJob, failReceipt, platform fee calculation
- `api/test/helpers/orders.test.mjs` — `parseOrderBody`, `parseLegacyStreamBody` validation

**Routes (5 files):**
- `api/test/routes/tasks.test.mjs` — `POST /tasks/run` validation, SSE relay, queue dispatch
- `api/test/routes/workers.test.mjs` — `GET /workers` auth & ownership, `GET /workers/public` public pool
- `api/test/routes/orders.test.mjs` — `GET /orders` auth & listing
- `api/test/routes/openai.test.mjs` — `POST /v1/chat/completions` worker matching, atomic claim, receipt creation, settlement flow
- `api/test/helpers/users.test.mjs` — user body parsing helpers

**Integration (1 file):**
- `api/test/integration/` — (pending comprehensive integration suite covering API + Worker + MySQL full workflows)

### Worker Tests (7 files)

**Unit (6 files):**
- `worker/test/unit/error.test.mjs` — `HttpError` & `CustomError`
- `worker/test/unit/middleware-error.test.mjs` — error middleware envelope
- `worker/test/unit/api-client.test.mjs` — `ApiStreamClient` connect/disconnect, register message, handle stream-job, reconnect with backoff
- `worker/test/unit/llm.test.mjs` — `LLM` streamOutput, parse SSE chunks, error handling
- `worker/test/unit/system-route.test.mjs` — `GET /ready` response shape and uptime calculation
- `worker/test/unit/stream-router-reconnect.test.mjs` — reconnect logic with exponential backoff

**Integration (1 file):**
- `worker/test/integration/stream-api.test.mjs` — end-to-end: worker registers → receives job → calls LLM mock → relays to API → client receives SSE

## Test Patterns

### File Structure

```js
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('ModuleName', () => {
  it('does X when given Y', () => {
    assert.equal(actual, expected);
    assert.match(str, regex);
    assert.throws(() => failingCode(), ErrorClass);
  });
});
```

### Fake WebSocket (for WSServer, StreamRouter, ApiStreamClient tests)

```js
function makeFakeSocket(overrides = {}) {
  const handlers = {};
  const listeners = {};

  return {
    readyState: WebSocket.OPEN,  // or CONNECTING, CLOSED
    send: mock.fn(),
    terminate: mock.fn(),
    
    on(event, handler) {
      handlers[event] = handler;
    },
    
    once(event, handler) {
      listeners[event] = handler;
    },
    
    emit(event, ...args) {
      handlers[event]?.(...args);
    },
    
    emitOnce(event, ...args) {
      listeners[event]?.(...args);
    },
    
    ...overrides
  };
}
```

### Fake HTTP Response (for HttpStream, route tests)

```js
function makeFakeRes(overrides = {}) {
  let statusCode = 200;
  const headers = {};
  const written = [];
  let ended = false;

  return {
    writableEnded: false,
    
    status(code) {
      statusCode = code;
      return this;
    },
    
    setHeader(key, value) {
      headers[key] = value;
    },
    
    flushHeaders: mock.fn(),
    
    write(chunk) {
      written.push(chunk);
      return true;
    },
    
    end() {
      ended = true;
      this.writableEnded = true;
    },
    
    once(event, fn) {
      if (event === 'close') this._onClose = fn;
    },
    
    // Inspection helpers
    _getStatusCode: () => statusCode,
    _getHeaders: () => headers,
    _getWritten: () => written,
    _isEnded: () => ended,
    
    ...overrides
  };
}
```

### Mock Fetch (for LLM SSE tests)

```js
import { mock } from 'node:test';

// Global mock returning SSE-style chunks
const encoder = new TextEncoder();
mock.method(globalThis, 'fetch', async () => ({
  ok: true,
  body: {
    getReader: () => {
      let callCount = 0;
      return {
        async read() {
          if (callCount++ > 0) return { done: true };
          
          return {
            done: false,
            value: encoder.encode(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
              'data: [DONE]\n\n'
            )
          };
        }
      };
    }
  }
}));
```

Or, for per-test control:

```js
const fetchMock = mock.fn(async (url, options) => {
  assert.equal(url, 'http://llm-runner:8000/...');
  return { ok: true, body: { getReader: () => ... } };
});

// Pass to LLM constructor if it accepts a fetch option
const llm = new LLM({ fetch: fetchMock });
```

### Real WebSocket Server in Tests

Use `WSServer` directly to avoid port conflicts:

```js
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { WSServer } from '../../helpers/wsserver.js';

let wss, port;

before(async () => {
  // port: 0 = OS-assigned free port
  wss = new WSServer({ port: 0, path: '/ws/test' });
  
  // Wait for server to be listening
  if (!wss.ws.address()) {
    await once(wss.ws, 'listening');
  }
  
  port = wss.ws.address().port;
});

after(async () => {
  // Cleanup all client connections
  for (const client of wss.ws.clients) {
    client.terminate();
  }
  
  // Close server
  await new Promise(resolve => {
    wss.ws.close(resolve);
  });
});

it('connects and registers', async () => {
  const client = new WebSocket(`ws://localhost:${port}/ws/test`);
  
  await once(client, 'open');
  
  client.send(JSON.stringify({
    type: 'worker-register',
    payload: { workerId: 'test-1', apiKey: 'key-abc', model: 'test', tps: 1, price: 0.01 }
  }));
  
  // Assert handler was called
  assert.ok(wss.handlerCalled);
});
```

### Dynamic Port for Integration Tests

Set `PORT` and `API_WS_PORT` to `0` before importing `app.js`:

```js
process.env.PORT = '0';
process.env.API_WS_PORT = '0';
process.env.MYSQL_ENABLED = 'false';  // Stub MySQL if testing without database

const { app, streamRouter } = await import('../../app.js');

// Wait for servers to be listening
const apiPort = app.address().port;
const wsPort = streamRouter.wsServer.ws.address().port;

// Now test against http://localhost:{apiPort} and ws://localhost:{wsPort}
```

### Lifecycle Hooks

```js
import { before, after, beforeEach, afterEach } from 'node:test';

describe('Module', () => {
  let resource;

  before(async () => {
    // Runs once before all tests in this block
    resource = await setupExpensiveResource();
  });

  after(async () => {
    // Runs once after all tests in this block
    await resource.cleanup();
  });

  beforeEach(() => {
    // Runs before each test
    mock.reset();
  });

  afterEach(() => {
    // Runs after each test
    // cleanup state
  });

  it('test 1', () => { /* ... */ });
  it('test 2', () => { /* ... */ });
});
```

### Stubbing MySQL (No Database Required)

Mock the Mysql module when testing models in isolation:

```js
import { UsersModel } from '../../models/users.js';

it('creates user', async () => {
  const stubMysql = {
    insert: mock.fn(async () => [{ insertId: 1 }]),
    find: mock.fn(async () => [{ id: 1, name: 'Alice', credits: 100 }]),
    upsert: mock.fn(async () => [{ affectedRows: 1 }])
  };

  const usersModel = new UsersModel({ mysql: stubMysql });
  const { user, apiKey } = await usersModel.register({ name: 'Alice' });

  assert.equal(user.id, 1);
  assert.equal(user.name, 'Alice');
  assert.ok(apiKey);
  assert.equal(stubMysql.insert.callCount, 1);
});
```

## Coverage by Component

When implementing new features, ensure tests cover:

| Component | Test Assertions |
|-----------|---|
| **Route handlers** | Valid request → correct response, missing/invalid fields → 400, auth failure → 401, not found → 404, internal error → 500 |
| **Models** | Happy path, validation errors, database errors, edge cases (empty results, duplicates) |
| **Queue** | add/shift order, requeue correct sequence, remove by id, getPosition (1-indexed), getSize |
| **HttpStream** | Headers set on construction, event() changes next event, send() writes SSE format, close() idempotent |
| **WSServer** | Message routing, unknown types ignored, send() formats JSON, broadcast reaches all OPEN clients |
| **StreamRouter** | enqueue → dispatch to available worker, cancel removes from queue, worker lifecycle (register→ready→complete/fail), settlement callback invoked |
| **ApiStreamClient** | connect() sends worker-register, message handlers invoked, reconnect with backoff, exponential delay capped |
| **LLM** | streamOutput parses SSE chunks, forwards to SocketStream, [DONE] triggers end event, fetch errors wrapped as HttpError |
| **Error handling** | All thrown errors caught, proper status and message propagated to client |

## Known Test Gaps (from audit)

**High priority:**
- Worker session edge cases: disconnection mid-job, duplicate registration, worker rotation
- Settlement concurrency: simultaneous requests for same worker, race conditions in markBusy
- Integration cycle: full user registration → worker binding → order dispatch → settlement → receipt history
- Consumer/worker matching with constraints (maxPrice, minTps)

**Medium priority:**
- API key rotation and invalidation
- Order receipt status transitions and timeouts
- Database transaction isolation (MySQL)

**Lower priority:**
- Edge cases in SSE chunk parsing
- Worker reconnect backoff timing

## Best Practices

1. **Use `node:assert/strict`** — strict equality by default prevents false positives.
2. **One assertion focus per test** — name tests for what they verify; use multiple `it()` blocks instead of combining unrelated checks.
3. **Mock external I/O** — fetch, WebSocket, database; don't hit real services.
4. **Use mock.fn()** — verify functions were called with expected arguments.
5. **Clean up in `after()`** — close servers, terminate sockets, reset globals.
6. **Avoid flaky timings** — use `once()` or events instead of arbitrary `setTimeout()` waits.
7. **Avoid shared state** — each test should be independent; reset mocks in `beforeEach()`.

## Done Criteria

- All test files use `node:test` + `node:assert/strict`.
- Tests run with `npm run test:unit` and `npm run test:integration` in each service.
- Happy paths + error/edge cases covered for any modified behavior.
- Untested behavior is explicitly flagged in the task handoff.
- No external service calls (all I/O mocked).
