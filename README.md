# Orderbook

Marketplace where API users register workers as rentable orderbook entries and consumers purchase streamed LLM access with per-order credit deduction.

Core design constraints:

- Workers connect outbound to the API over WebSocket; the API owns all client-facing routes.
- API HTTP composition is intentionally thin: `api/app.js` wires middleware/startup and mounts resource routers from `api/routes/`.
- Database interactions must go through MySQL driver methods only (current driver module: `api/helpers/mysql.js`). No raw SQL is allowed outside the driver.
- `GET /ready` on the API reports worker capacity and queue depth.
- Schema creation and schema changes are managed by explicit SQL scripts/migrations executed outside app runtime.

## Services

| Service | Folder | Host Port | Responsibility |
| --- | --- | --- | --- |
| `api` | `api/` | `80` | Client-facing `GET /ready`, `POST /tasks/run`, `GET /workers/pool`, `POST /v1/chat/completions`, queueing, SSE relay, worker WebSocket server |
| `worker` | `worker/` | not published by compose | Outbound WebSocket client that executes model streams and returns chunk events |
| MySQL | external | `3306` | Persistent store for users and orders; required when `MYSQL_ENABLED=true` |

## Runtime Flow

### Worker Registration and Binding

1. A provider registers a user account via `POST /users/users`, which generates a unique `api_key`.
2. The worker service connects to the API WebSocket endpoint (`ws://.../ws/workers`) and sends a `worker-register` message with its `workerId` and the user's `api_key` in the payload.
3. The API validates the API key against the registered user and permanently binds the worker to that user. The binding is immutable: once a worker is bound to a user, the binding cannot be changed, protecting against hijacking attacks under concurrent registration attempts.
4. Bound workers are recorded in the `workers` table with `user_id` ownership and status tracking (`connected`, `disconnected`).

### Stream Task Dispatch

1. A client can submit a direct run task using `POST /tasks/run` with `{ "model", "message" }` (or `input` alias).
2. The API enqueues the task in `StreamRouter` and starts an SSE response stream.
3. The router dispatches queued work to a compatible connected worker over `/ws/workers`.
4. Worker chunk events are relayed back to the HTTP stream (`message`, `end`, `error`).

### OpenAI-Compatible Dispatch

1. A client calls `POST /v1/chat/completions` with bearer API key auth and `stream: true`.
2. The API resolves the requester identity, finds the first available offer for the requested model, creates/consumes an internal order, and dispatches to the selected worker.
3. The response is streamed as OpenAI chunk-style SSE and ends with `[DONE]`.

## API Contract

### `GET /ready`

Returns current API queue depth and worker capacity.

```json
{
  "ok": true,
  "connectedWorkers": 5,
  "availableWorkers": 5,
  "activeJobs": 0,
  "queuedJobs": 0
}
```

---

### `GET /workers/pool`

Returns an owner-scoped snapshot of the current worker pool, combining persisted worker bindings/offers with live runtime status.

- Header: `Authorization: Bearer <api_key>`
- Response `200`: `{ "ok": true, "workers": [...] }`
- Returns `401` when bearer auth is missing/invalid.

Worker objects include:

- `id`, `userId`
- `status`, `connected`, `available`, `activeJobId`
- `model`, `price`, `tps`, `offerId`
- `connectedAt`, `disconnectedAt`, `lastSeenAt`, `createdAt`, `updatedAt`

This endpoint is visibility-safe by design: it resolves owner identity from API key and only returns workers/offers owned by that user.

---

### Worker Registration and API Key Binding

#### WebSocket Worker Registration

Workers connect via WebSocket at `ws://<api-host>/ws/workers` and send a `worker-register` message:

```json
{
  "type": "worker-register",
  "payload": {
    "workerId": "worker-001",
    "apiKey": "<user-api-key>",
    "hostname": "worker-hostname",
    "pid": 12345
  }
}
```

On successful registration:
- The API validates the `apiKey` against the user account and binds the worker to that user.
- The worker is recorded in the `workers` table with immutable `user_id` ownership.
- Worker status transitions to `connected`.
- Orders owned by the same user are eligible for auto-matching with this worker.

Security: Worker-to-user binding is immutable after initial registration. Duplicate registration attempts for the same `workerId` by different API keys will be rejected, preventing accidental or malicious worker hijacking.

Concurrency safety detail: after upsert, ownership is re-read from persistence and compared with the authenticated user. If ownership does not match, registration is rejected.

---

### Users

Users routes are mounted at `/users`. The current router paths include an extra `/users` segment, so the effective endpoints are `/users/users` and `/users/users/:apiKey/...`.

#### `POST /users/users`

Registers a new user account.

- Request body: `{ "name"?: string, "email"?: string }`
- Response `201`: `{ "ok": true, "user": { id, name, email, credits, createdAt, updatedAt } }`

#### `GET /users/users`

Lists all registered users with optional pagination.

- Query params: `limit` (default 50, max 100), `offset` (default 0)
- Response `200`: `{ "ok": true, "users": [...] }`

#### `GET /users/users/:apiKey`

Returns a single user profile.

- Response `200`: `{ "ok": true, "user": {...} }` or `404` if not found.

#### `PUT /users/users/:apiKey`

Updates mutable user fields (`name`, `email`).

- Request body: `{ "name"?: string, "email"?: string }`
- Response `200`: `{ "ok": true, "user": {...} }`

#### `POST /users/users/:apiKey/recharge`

Adds credits to a user account.

- Request body: `{ "amount": number }` (must be positive)
- Response `200`: `{ "ok": true, "user": {...} }`

#### `POST /users/users/:apiKey/reset`

Rotates the caller API key.

- Response `200`: `{ "ok": true, "user": {...}, "apiKey": "..." }`

#### `DELETE /users/users/:apiKey`

Deletes a user account and cascades to owned orders.

- Response `200`: `{ "ok": true }`

---

### Stream Tasks

#### `POST /tasks/run`

Enqueues a stream task and returns an SSE stream relayed from a connected worker.

- Request body: `{ "model": string, "message": string }` (`input` is accepted as an alias for `message`)
- The connection stays open while chunks are streamed (`message`, `end`, `error`).

---

### OpenAI-Compatible Streaming

#### `POST /v1/chat/completions`

OpenAI-compatible streaming route.

- Header: `Authorization: Bearer <api_key>`
- Request body: `{ "model": string, "messages": [...], "stream": true }`
- Behavior:
  - Resolves requester identity from bearer API key.
  - Selects the first available offer for the requested model.
  - Creates and consumes an internal order, then dispatches to the selected worker.
  - Streams OpenAI chunk-style SSE output and ends with `[DONE]`.
  - Uses shared SSE header behavior from `api/helpers/stream.js` (single header policy).
- Returns `409` when no worker is available for the requested model.

---

## Workers Table and Schema

The `workers` table stores bindings between worker instances and user accounts. It is created via `api/schema.sql` and includes:

| Column | Type | Constraints | Purpose |
|--------|------|-------------|----------|
| `id` | VARCHAR(128) | PRIMARY KEY | Worker instance identifier |
| `user_id` | VARCHAR(128) | NOT NULL, FK → users(id) | Owner user; immutable after initial binding |
| `status` | VARCHAR(24) | DEFAULT 'connected' | Connection state: `connected`, `disconnected` |
| `connected_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | Timestamp of most recent connection |
| `disconnected_at` | DATETIME | NULL | Timestamp of most recent disconnection |
| `last_seen_at` | DATETIME | NOT NULL | Timestamp of last activity |
| `created_at` | DATETIME | DEFAULT CURRENT_TIMESTAMP | Account creation time |
| `updated_at` | DATETIME | AUTO UPDATE | Last modification time |

Indexes: `user_id`, `status`, `(user_id, status)` for fast lookups during matching and availability checks.

See `api/schema.sql` for the full CREATE TABLE statement.

---

## Architecture Conventions

### SQL Confinement

**All SQL lives exclusively in the MySQL driver module (`api/helpers/mysql.js`).**

Routes, models, helpers, and middleware must not embed raw SQL. If persistence behavior is missing, add a new public driver method and consume that method from model code.

### Schema Management

MySQL is opt-in. When `MYSQL_ENABLED=false` (the default), the API starts without a database and persistence-backed routes (users, workers pool, OpenAI order-backed dispatch) return `503`. Set `MYSQL_ENABLED=true` and provide connection env vars to enable persistence.

Do not create or alter schema at application startup. Apply schema changes through versioned SQL scripts/migrations and run them manually on the target connection.

### Layer Ownership

- MySQL driver stays generic and business-logic free.
- Models are the exclusive owners of entity business logic.
- Entity business logic must not be implemented in routers, helpers, middleware, or the driver.
- Models perform SQL operations through driver methods.
- Routers stay thin: request parsing/validation, response shaping, and calls into models/helpers only.
- Helpers own only cross-entity/non-entity business logic (for example: pricing and worker availability checks).

### Architecture Direction

Prioritize clean current architecture over legacy compatibility patches because this project is pre-launch.

### References as Standard

When a task asks to follow references, treat `.github/references/` (especially `api1`) as mandatory implementation guidance.

---

## Repository Layout

```text
api/
  app.js                 # API entrypoint and worker WebSocket server
  compose.yaml           # API compose file (host port 80 → container 3000)
  Dockerfile
  package.json
  helpers/
    error.js             # HttpError: HTTP-safe error type
    auth.js              # Bearer API key parsing helpers
    mysql.js             # MySQL driver and SQL confinement boundary
    orders.js            # Shared payload parsers for task/openai dispatch inputs
    queue.js             # FIFO queue for pending stream jobs
    router.js            # StreamRouter: worker registration, targeted dispatch, job lifecycle
    response.js          # HTTP success response helpers
    stream.js            # SSE stream helpers and header application
    users.js             # User parse/validate helpers
    wsserver.js          # WSServer: typed WebSocket server for worker messages
  middleware/
    error.js             # JSON error envelope middleware
  models/
    orders.js            # OrdersModel: offer/order business logic over drivers
    users.js             # UsersModel: user business logic over UsersDriver
    workers.js           # WorkersModel: worker ownership, visibility, and TPS updates
  routes/
    openai.js            # /v1/chat/completions OpenAI-compatible streaming
    tasks.js             # /tasks/run direct stream task endpoint
    users.js             # /users/users* account routes
    workers.js           # /workers/pool owner-scoped worker pool route
  test/
    helpers/             # Helper-level tests (auth/orders/router/users)
    integration/         # Integration tests for worker binding and stream flows
    models/              # Model-level tests (orders/users/workers)
    routes/              # Route tests (openai/tasks/workers)
    unit/                # Unit tests for shared helpers/middleware
  compose.yaml           # API compose stack; publishes API on host port 80

worker/
  app.js                 # Worker entrypoint and outbound API WebSocket client
  compose.dev.yaml       # Worker development compose file (no exposed ports)
  Dockerfile
  package.json
  helpers/
    api-client.js        # Worker socket lifecycle and job relay
    error.js             # Worker-side HTTP/model error types
  middleware/
    error.js             # Worker HTTP error envelope middleware
  model/
    llm.js               # Model runner SSE parser used by stream jobs
  routes/
    system.js            # Local worker `/ready` endpoint for process checks
  compose.dev.yaml       # Worker dev compose stack
```

---

## Running Locally

### Docker Compose (with MySQL)

```sh
docker compose -f api/compose.yaml up -d --build api
docker compose -f worker/compose.dev.yaml up -d --build worker
curl -sS http://127.0.0.1/ready
```

The API compose file publishes the API on `127.0.0.1:80` and the worker compose file keeps workers internal to the `llm` compose network.

### API Standalone

```sh
cd api
npm install
# Without MySQL (streaming infra only):
PORT=3300 node app.js
# With MySQL:
PORT=3300 \
MYSQL_ENABLED=true \
MYSQL_HOST=127.0.0.1 \
MYSQL_USER=root \
MYSQL_PASSWORD=secret \
MYSQL_DATABASE=orderbook \
node app.js
```

### Worker Standalone

```sh
cd worker
npm install
PORT=3301 \
API_WS_URL=ws://127.0.0.1:3300/ws/workers \
MODEL_RUNNER_HOST=http://127.0.0.1:3900 \
node app.js
```

Choose different `PORT` values so the worker's local health server does not collide with the API.

---

## Environment Variables

### API

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API listen port |
| `API_WS_PORT` | `3000` | Port for the WebSocket server that workers connect to |
| `WORKER_ROUTE` | `/ws/workers` | WebSocket path used by workers to register and receive jobs |
| `NODE_ENV` | unset | Controls whether error payloads include debug data |

### Worker

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local worker HTTP port for `/ready` health check |
| `API_WS_URL` | `ws://127.0.0.1:3000/ws/workers` | Outbound WebSocket URL for API registration |
| `MODEL_RUNNER_HOST` | unset | Base URL for the model runner SSE API |
| `MODEL_RUNNER_MODEL` | unset | Default model name when a request does not supply one |
| `NODE_ENV` | unset | Controls whether worker error payloads include debug data |

---

## Running Tests

### Worker

```sh
cd worker && npm test
```

Unit-only or integration-only:

```sh
cd worker && npm run test:unit
cd worker && npm run test:integration
```

### API

```sh
cd api && npm test
```

Unit-only or integration-only:

```sh
cd api && npm run test:unit
cd api && npm run test:integration
```

The API suite covers route behavior (`tasks`, `workers/pool`, OpenAI stream), worker registration/binding safety, queue/stream helpers, and model persistence logic (`users`, `orders`, `workers`).

