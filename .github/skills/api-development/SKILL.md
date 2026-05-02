---
name: api-development
description: Build and maintain the API and Worker services for this LLM streaming relay project. Use when adding or modifying routes, request validation, SSE relay logic, queue behavior, WebSocket server events, LLM model runner integration, or marketplace order/settlement flows.
---

# API Development

## Architecture Overview

LocalLMarket is a peer-to-peer LLM compute marketplace. Workers (providers) register to the API over WebSocket and expose computational capacity. Consumers submit streaming requests, which the API matches to available workers, handles billing, and relays output as Server-Sent Events.

**Two services:**
- **`api/`** — Express HTTP server. Owns client-facing routes, worker WebSocket server, job queue, SSE relay, user/worker/order database models.
- **`worker/`** — Express HTTP health server + persistent outbound WebSocket client. Registers to API, processes dispatched jobs by calling LLM runner, sends stream events back.

## HTTP API Endpoints

Base URL: `http://localhost/` (port 80 via compose)

### Health & Status

| Method | Path | Auth | Returns | Purpose |
|--------|------|------|---------|---------|
| `GET` | `/ready` | none | `{ ok, connectedWorkers, availableWorkers, activeJobs, queuedJobs }` | Readiness probe; queue/worker snapshot |

### Tasks (Direct Stream Dispatch)

| Method | Path | Auth | Returns | Purpose |
|--------|------|------|---------|---------|
| `POST` | `/tasks/run` | none | `text/event-stream` | Enqueue a legacy streaming task |

**Request body:**
```json
{ "message": "Say hello", "model": "ai/smollm2" }
```
(`input` alias also accepted for `message`). On success, returns SSE stream with events: `message` (chunk), `end` (completion), `error` (failure).

### Workers

| Method | Path | Auth | Returns | Purpose |
|--------|------|------|---------|---------|
| `GET` | `/workers` | Bearer token | `{ ok, workers: [...] }` | Owner-scoped workers (authenticated requester only) |
| `GET` | `/workers/public` | none | `{ ok, workers: [...] }` | Public worker pool (id, model, tps, price, status, availability) |

### Orders (Execution Receipts)

| Method | Path | Auth | Returns | Purpose |
|--------|------|------|---------|---------|
| `GET` | `/orders` | Bearer token | `{ ok, orders: [...] }` | Authenticated requester's past execution receipts |

**Order object:** `{ id, requester_id, worker_id, model, price, tps, status, started_at, completed_at, created_at, updated_at }`

### OpenAI-Compatible Streaming

| Method | Path | Auth | Returns | Purpose |
|--------|------|------|---------|---------|
| `POST` | `/v1/chat/completions` | Bearer token | `text/event-stream` | Match consumer → worker → stream result (billing-aware) |
| `POST` | `/v1/responses` | Bearer token | `text/event-stream` | Alternative completion endpoint |

**Request body (OpenAI subset):**
```json
{ "model": "ai/smollm2", "messages": [...], "stream": true }
```

Worker matching:  Find first available worker for model within consumer's `maxPrice` and `minTps` constraints. Atomically claim it, create receipt, dispatch, relay stream, settle billing.

### Users & Account Management

| Method | Path | Auth | Body | Returns | Purpose |
|--------|------|------|------|---------|---------|
| `POST` | `/users` | none | `{ name?, email? }` | `{ ok, user: {..., apiKey} }` (201) | Register new user; returns generated API key |
| `GET` | `/users` | Bearer token | — | `{ ok, user: {...} }` | Fetch authenticated user profile |
| `PUT` | `/users` | Bearer token | `{ name?, email? }` | `{ ok, user: {...} }` | Update user name/email |
| `POST` | `/users/recharge` | Bearer token | `{ amount: number }` | `{ ok, user: {...} }` | Add credits to account |
| `POST` | `/users/reset` | Bearer token | — | `{ ok, user: {...}, apiKey }` | Rotate API key |
| `DELETE` | `/users` | Bearer token | — | `{ ok }` | Delete account |

## Response & Error Envelopes

### Success Response

```js
// api/helpers/response.js
export function sendSuccess(res, { status = 200, body = {}, message } = {}) {
  return res.status(status).json({
    ok: true,
    ...body,
    ...(message && { message })
  });
}

export function sendCreated(res, { body = {}, message } = {}) {
  return sendSuccess(res, { status: 201, body, message });
}
```

**Example:**
```json
{ "ok": true, "user": { "id": 1, "name": "Alice", "credits": 100 }, "apiKey": "abc123..." }
```

### Error Response

```js
// api/middleware/error.js formats all errors
{ "error": true, "status": 400, "type": "Bad Request", "message": "..." }
```

All HTTP errors must be raised as `HttpError(status, message)` from `api/helpers/error.js`. The terminal error middleware converts them to the above envelope.

## Key Architecture Patterns

### Route Factories (Dependency Injection)

Routes are mounted via factory functions that accept dependencies:

```js
// api/routes/workers.js
export function workersRouterFactory({ workersModel, streamRouter }) {
  const router = express.Router();
  router.get('/', async (req, res, next) => {
    // route implementation
  });
  return router;
}

// api/app.js
app.use('/workers', workersRouterFactory({ workersModel, streamRouter }));
```

**Why:** Enables testability (inject mocks) and decoupling of routes from globals.

### StreamRouter & Job Dispatch

```js
// api/helpers/router.js
export class StreamRouter {
  enqueue(job)         // add job to queue; dispatch to available worker
  cancel(jobId)        // remove queued or active job
  getState()           // { connectedWorkers, availableWorkers, activeJobs, queuedJobs }
  getWorkersSnapshot() // runtime worker state with live activity
}
```

- **`enqueue(job)`**: Accepts `{ payload: { message, model }, stream, targetWorkerId?, settlement?, onJobAborted? }`. Returns `jobId`. If a worker is available, dispatches immediately; otherwise queues.
- **`cancel(jobId)`**: Removes job from queue or aborts active dispatch.
- **Settlement**: When `settlement: { orderId, requesterId }` is provided, the router calls `ordersModel.settleCompletedJob()` after the worker signals completion.

### Worker Registration & Binding

Workers connect via **WebSocket at `ws://api:3000/ws/workers`** (internal Docker network) and send:

```json
{
  "type": "worker-register",
  "payload": {
    "workerId": "worker-001",
    "apiKey": "<user-api-key>",
    "model": "ai/smollm2",
    "tps": 50,
    "price": 0.01
  }
}
```

**API validation (api/models/workers.js):**
- Lookup user by `apiKey` (encrypted at rest via `api/helpers/secure-key.js`)
- Validate model, tps, price
- Bind worker immutably to user: `INSERT INTO workers (id, user_id, model, tps, price) VALUES (...) ON DUPLICATE UPDATE ...`
- Concurrency safe: re-read ownership after upsert; reject if user mismatch

### SSE Stream Relay

```js
// api/helpers/stream.js
export class HttpStream {
  event(name)    // set next event name (default "message")
  send(data)     // write SSE line: "event: <name>\ndata: <data>\n\n"
  close()        // end response
}
```

Example sequence for `/tasks/run`:
1. Enqueue job with new `HttpStream(res)`
2. Worker sends `stream-event` → API parses, calls `stream.event('message').send(chunk)`
3. Worker sends `[DONE]` → `stream.event('end').send('complete')`
4. `stream.close()` ends the response

### Models Own Business Logic

```js
// api/models/users.js
export class UsersModel {
  register(payload)           // create user + generate API key
  getByApiKey(apiKey)        // lookup + verify
  rechargeById(userId, amount)
  resetApiKeyById(userId)    // rotate key
}

// api/models/workers.js
export class WorkersModel {
  bindConnectedWorker(input)              // register WebSocket worker
  listPoolByOwner(userId, runtimeState)   // owner's workers
  listPublic()                            // public pool
  findFirstAvailableByModel(model, constraints, streamRouter)
  markBusy(workerId)                      // claim for dispatch
  markDisconnected(workerId)              // handle socket close
}

// api/models/orders.js
export class OrdersModel {
  createReceipt(requesterId, { workerId, model, price })  // on dispatch
  settleCompletedJob(input)  // billing: debit requester, credit provider (minus fee)
  failReceipt(orderId)       // mark failed
}
```

Models use `Mysql` helper (api/helpers/mysql.js) for all database access. No raw SQL outside models.

### WebSocket Message Protocol (API ↔ Worker)

All messages: `{ "type": "...", "payload": {...} }`

**Worker → API:**
- `worker-register` — initial registration (see above)
- `worker-ready` — signals availability after job completion
- `stream-event` — `{ jobId, event, data }` — relay LLM output chunk
- `job-complete` — `{ jobId, usage: {...} }` — job finished successfully
- `job-failed` — `{ jobId, error: "..." }` — job failed

**API → Worker:**
- `stream-job` — `{ jobId, payload: { message, model } }` — dispatch task
- `cancel-job` — `{ jobId }` — abort task

## Database Schema Essentials

```sql
-- api/schema.sql (loaded at startup)
CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255),
  email VARCHAR(255),
  credits DECIMAL(18, 8),
  api_key_digest VARCHAR(64),     -- indexed lookup
  api_key_cipher VARCHAR(255),    -- encrypted AES-256-GCM
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workers (
  id VARCHAR(255) PRIMARY KEY,
  user_id BIGINT,                 -- immutable binding
  model VARCHAR(255),
  tps INT,
  price DECIMAL(18, 8),
  status ENUM('connected', 'disconnected'),
  connected_at TIMESTAMP,
  disconnected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  requester_id BIGINT,
  worker_id VARCHAR(255),
  model VARCHAR(255),
  price DECIMAL(18, 8),
  status ENUM('running', 'completed', 'failed'),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Security Patterns

- **API Key Encryption**: Stored as AES-256-GCM ciphertext; indexed via HMAC digest for O(1) lookup without decryption.
- **Bearer Token Auth**: `Authorization: Bearer <api-key>` parsed by `api/helpers/auth.js`.
- **Worker Immutability**: Once a worker is bound to a user, the binding cannot change. Prevents hijacking.
- **No Self-Orders**: Validation prevents a consumer from purchasing work from their own workers (conflict of interest).
- **Atomicity**: Worker claim (`markBusy`) and receipt creation are separate but ordered; concurrent consumers race fairly.

## When to Use StreamRouter vs Direct Handlers

- **Use StreamRouter** (`enqueue()`, `cancel()`) when the job requires live worker dispatch and SSE relay.
- **Use direct handlers** (inline middleware) for stateless validation-only endpoints.

## Common Pitfalls

1. **Forgetting to pass `streamRouter`** to route factories → routes can't dispatch jobs.
2. **Mutating model objects** after query → causes stale data in re-dispatches; reassign instead.
3. **Not catching `HttpError`** in route handlers → uncaught errors bypass error middleware.
4. **Raw SQL outside models** → violates architecture; always use Mysql helper.
- `job-complete` — `{ jobId }`
- `job-failed` — `{ jobId, error }`

API → Worker:
- `stream-job` — `{ jobId, payload: { message, model } }`
- `worker-ready-request` — broadcast when queue has jobs but no available worker

## LLM Model Runner

`LLM` in `worker/model/llm.js` calls:
```
POST {MODEL_RUNNER_HOST}/engines/llama.cpp/v1/chat/completions
```
with `stream: true`. Environment variables:
- `MODEL_RUNNER_HOST` — base URL (e.g., `http://model-runner.docker.internal:80`)
- `MODEL_RUNNER_MODEL` — default model identifier

## Implementation Checklist

When adding or modifying API behavior:

1. Add/modify route in `api/app.js` (or new route file if substantial).
2. Validate request body in the route handler; throw `HttpError` for bad input.
3. Use `StreamRouter` for any operation that touches the worker dispatch queue.
4. For new `WSServer` message types, register a handler via `wsServer.on('<type>', handler)`.
5. For new worker messages, add the corresponding send call in `ApiStreamClient`.
6. Preserve the SSE event contract: `message`, `end`, `error`.
7. Update `GET /ready` payload if new state is relevant to health checks.
8. Add JSDoc to any new exported class, method, or function you touch.
9. Add or update tests in `api/test/unit/` and/or `api/test/integration/`.
10. Run `cd api && npm test` and confirm all tests pass before marking work done.

When adding or modifying Worker behavior:

1. Update `ApiStreamClient` for new job message types or LLM model runner calls.
2. Keep LLM interaction isolated in `worker/model/llm.js`.
3. Keep the worker HTTP surface limited to health/readiness — do not add new HTTP endpoints for LLM traffic.
4. Add or update tests in `worker/test/unit/` or `worker/test/integration/`.
5. Run `cd worker && npm test` and confirm all tests pass.

## Market-Style Order Matching

Order matching is a cross-entity concern implemented in `api/helpers/matching.js` via the `OrderMatchingHelper` class.

### When to Add Matching Behavior

1. **Trigger on order mutations**: When `OrdersModel.create()` or `OrdersModel.updateOwn()` complete, invoke `matchingHelper.#triggerMatchingAsync()` to evaluate and apply available matches.
2. **Trigger on worker availability**: When `StreamRouter.registerWorker()` successfully binds a worker, invoke `matchingHelper.#triggerOrderMatchingAsync()` to match pending orders with the newly available worker.
3. **Keep triggers async and fire-and-forget**: Do not await matching results in the request handler; use `.catch()` to suppress errors so matching failures do not crash the HTTP response path.

### Matching Flow

1. Matching finds unmatched, available orders owned by a given user.
2. For each order, `#findAvailableWorkerForOrder()` queries for a connected, available worker owned by the same user (order creator).
3. If a worker match is found, `#consumeOrderTransaction()` atomically (1) consumes the order, (2) debits the consumer's credits, and (3) locks rows to prevent race conditions.
4. On successful consumption, `#dispatchJobToWorker()` enqueues the job to the matched worker via `StreamRouter.enqueue()`.
5. If the job is aborted (e.g., worker disconnects while queued), `unconsumForUse()` rolls back the consumption and refunds credits.

### Ownership Enforcement Patterns

Ownership checks are mandatory at all mutation points to prevent cross-user resource access:

1. **Worker ownership**: Before matching an order with a worker, verify that both the order and the worker are owned by the same user via `StreamRouter.isWorkerOwnedBy(workerId, userId)`.
2. **Order creation**: Validate that the requested `workerId` exists and is owned by the order creator's `user_id`. Do not allow creating orders with workers from other users.
3. **Order consumption**: When consuming an order via `POST /workers/:orderId/use`, verify that the consumer's credits are sufficient and that the target worker belongs to the order creator (not the consumer). The order creator acts as the provider; the consumer is a different user.
4. **Transactional safety**: Use transactional WHERE clauses (e.g., `WHERE is_consumed = 0 AND is_available = 1`) and row-level locks (`FOR UPDATE`) to ensure that double-consumption and double-debit are atomically prevented, not just checked before the mutation.

## Architecture Guardrails (Mandatory)

1. Never create or patch schema from live application code. Use explicit SQL scripts/migrations only, executed outside app startup.
2. Never write raw SQL outside the MySQL driver module (`api/helpers/mysql.js`).
3. If persistence behavior is missing, add a new generic MySQL driver method and call it from models.
4. Keep MySQL driver logic generic and reusable; do not place business/domain policy in driver methods.
5. Models are the exclusive owners of entity business logic. Entity business logic must not be implemented in routers, helpers, middleware, or the MySQL driver.
6. Routers must stay thin (request/response orchestration only). Helpers are limited to cross-entity/non-entity logic such as pricing, worker availability, or order matching.
7. Favor clean current architecture over legacy compatibility patches for this pre-launch project.
8. When requested to follow references, treat `.github/references/` (especially `api1`) as strict standards.

## Conventions

- ESM only — `"type": "module"` in both `package.json` files; use `import`/`export` throughout.
- Node.js 22+; no transpilation, no Babel.
- MySQL usage follows driver-method boundaries and migration-only schema management.
- Keep HTTP surface limited to `GET` and `POST`; avoid `PUT`/`PATCH`/`DELETE` unless clearly required.
- Propagate errors to `next(error)` in route handlers; let `errorMiddleware` format the response.
