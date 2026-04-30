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
| `api` | `api/` | `80` | Client-facing `GET /ready`, `POST /stream`, queueing, SSE relay, worker WebSocket server |
| `worker` | `worker/` | not published by compose | Outbound WebSocket client that executes model streams and returns chunk events |
| MySQL | external | `3306` | Persistent store for users and orders; required when `MYSQL_ENABLED=true` |

## Runtime Flow

### Worker Registration and Binding

1. A provider registers a user account via `POST /users`, which generates a unique `api_key`.
2. The worker service connects to the API WebSocket endpoint (`ws://.../ws/workers`) and sends a `worker-register` message with its `workerId` and the user's `api_key` in the payload.
3. The API validates the API key against the registered user and permanently binds the worker to that user. The binding is immutable: once a worker is bound to a user, the binding cannot be changed, protecting against hijacking attacks under concurrent registration attempts.
4. Bound workers are recorded in the `workers` table with `user_id` ownership and status tracking (`connected`, `disconnected`).

### Order Creation and Market-Style Matching

1. With the worker connected and bound, the provider creates orderbook entries via `POST /order` specifying `workerId`, `model`, `price`, and `tps`.
2. Each order is assigned ownership (`user_id`) and availability status. Orders are initially unmatched and available for consumers.
3. Orders automatically trigger a **market-style matching flow**: the API finds connected workers owned by the same user (`user_id`), checks for available inventory, and pre-fills matching orders by atomically consuming them and dispatching jobs to available workers.
4. Matching is race-free: orders are consumed transactionally with `FOR UPDATE` locks, preventing double-consumption and double-debit scenarios.
5. A consumer registers their own user account and recharges credits via `POST /users/:id/recharge`.
6. The consumer browses available orders via `GET /orders` (with optional model/price/tps/availability filters).
7. The consumer calls `POST /workers/:orderid/use` supplying the request `message`. The API:
   - Validates the order is available and the target worker is connected and owned by the order creator.
   - Atomically marks the order as consumed and deducts credits from the consumer's account.
   - Opens an SSE response immediately and dispatches the job to the reserved worker.
   - Relays `message`, `end`, and `error` events back to the consumer over SSE.
   - If the targeted worker disconnects while the job is still queued, the order and credits are automatically refunded via a compensating transaction.

### Legacy Compatibility

`POST /stream` supports two compatibility modes:

- Legacy mode: no `orderId` in body, requires `{ "model", "message" }`, and enqueues a model-based untargeted stream job.
- Order-consume mode: body includes `orderId`, then behavior matches `POST /workers/:orderid/use` (consume order, debit credits, targeted worker dispatch).

New consumers should use `POST /workers/:orderid/use`.

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

---

### Users

#### `POST /users`

Registers a new user account.

- Request body: `{ "name"?: string, "email"?: string }`
- Response `201`: `{ "ok": true, "user": { id, name, email, credits, createdAt, updatedAt } }`

#### `GET /users`

Lists all registered users with optional pagination.

- Query params: `limit` (default 50, max 100), `offset` (default 0)
- Response `200`: `{ "ok": true, "users": [...] }`

#### `GET /users/:id`

Returns a single user profile.

- Response `200`: `{ "ok": true, "user": {...} }` or `404` if not found.

#### `PUT /users/:id`

Updates mutable user fields (`name`, `email`).

- Request body: `{ "name"?: string, "email"?: string }`
- Response `200`: `{ "ok": true, "user": {...} }`

#### `POST /users/:id/recharge`

Adds credits to a user account.

- Request body: `{ "amount": number }` (must be positive)
- Response `200`: `{ "ok": true, "user": {...} }`

#### `DELETE /users/:id`

Deletes a user account and cascades to owned orders.

- Response `200`: `{ "ok": true }`

---

### Orderbook

Owner/consumer identity is passed as the `x-user-id` header on owner-scoped and consume routes.

#### `POST /order`

Creates a new orderbook entry. Requires the specified worker to be currently connected.

- Header: `x-user-id: <id>`
- Request body: `{ "workerId": string, "model": string, "price": number, "tps": number }`
- Response `201`: `{ "ok": true, "order": { id, workerId, model, price, tps, isAvailable, isConsumed, createdAt } }`
- Returns `422` if the worker is not connected; `400` on invalid payload.

#### `GET /orders`

Public listing of orderbook entries with optional filters.

- Query params: `model`, `minPrice`, `maxPrice`, `minTps`, `maxTps`, `onlyAvailable` (boolean)
- Response `200`: `{ "ok": true, "orders": [...] }` — runtime `isAvailable` overlays live worker connectivity state.

#### `GET /order/:orderId`

Returns a single owner-scoped order.

- Header: `x-user-id: <id>`
- Response `200`: `{ "ok": true, "order": {...} }` or `403`/`404` on mismatch.

#### `PUT /order/:orderId`

Updates an owner-scoped order (`model`, `price`, `tps`).

- Header: `x-user-id: <id>`
- Request body: `{ "model"?: string, "price"?: number, "tps"?: number }`
- Response `200`: `{ "ok": true, "order": {...} }`

#### `DELETE /order/:orderId`

Deletes an owner-scoped order.

- Header: `x-user-id: <id>`
- Response `200`: `{ "ok": true }`

---

### Worker Use (Consume)

#### `POST /workers/:orderid/use`

Consumes an order and streams the worker's model response to the caller via Server-Sent Events.

- Header: `x-user-id: <consumerId>`
- Request body: `{ "message": string }` (or `{ "input": string }` compatibility alias)
- The API atomically marks the order as consumed and deducts the order `price` from the consumer's credits before streaming begins.
- If the target worker disconnects while the job is still queued, the consumption is reversed and credits are refunded automatically.
- Returns `400` if the order is not found or already consumed; `402` if the consumer has insufficient credits; `503` if the target worker is unavailable.

Example request:

```sh
curl --max-time 45 -sS -N \
  -X POST http://127.0.0.1:3000/workers/42/use \
  -H 'content-type: application/json' \
  -H 'x-user-id: user-abc' \
  --data '{"message":"Reply with OK only."}'
```

Example SSE stream:

```text
event: message
data: OK

event: end
data: Stream complete.
```

#### `POST /stream` (legacy)

Compatibility endpoint with dual behavior:

- Legacy mode (no `orderId`): parses `{ "model": string, "message": string }` and enqueues a non-targeted model stream.
- Order-consume mode (with `orderId`): behaves like `POST /workers/:orderid/use`.

- Request body (legacy mode): `{ "model": string, "message": string }`
- Request body (order-consume mode): `{ "orderId": string|number, "message": string }`
- New consumers should use `POST /workers/:orderid/use` instead.

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

MySQL is opt-in. When `MYSQL_ENABLED=false` (the default), the API starts without a database and all user/order routes return `503`. Set `MYSQL_ENABLED=true` and provide connection env vars to enable persistence.

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
    orders.js            # Order parse/validate helpers; applyOrderUseStream SSE handler
    queue.js             # FIFO queue for pending stream jobs
    router.js            # StreamRouter: worker registration, targeted dispatch, job lifecycle
    stream.js            # HttpStream: SSE response wrapper
    users.js             # User parse/validate helpers
    wsserver.js          # WSServer: typed WebSocket server for worker messages
  middleware/
    error.js             # JSON error envelope middleware
  models/
    orders.js            # OrdersModel: orderbook business logic over drivers
    users.js             # UsersModel: user business logic over UsersDriver
  routes/
    orders.js            # /order and /orders resource handlers
    stream.js            # /stream and /workers/:orderid/use handlers
    users.js             # /users resource handlers
  test/
    helpers/
      orders.test.mjs    # Parse/validate helpers + applyOrderUseStream route tests
      router.test.mjs    # StreamRouter targeted dispatch and session-safety tests
      users.test.mjs     # User parse/validate helper tests
    models/
      orders.test.mjs    # OrdersModel business logic + unconsumForUse tests
      users.test.mjs     # UsersModel business logic tests
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

The API suite covers: user parse/validate helpers, user model business logic, order parse/validate helpers, `applyOrderUseStream` and legacy `applyLegacyStream` behavior, route-level stream dispatch, `StreamRouter` targeted dispatch and session-safety, MySQL driver public method surface and SQL confinement, and `OrdersModel` consume/unconsume status mapping. All tests pass (72 as of the last verified run; count grows with each feature addition).

