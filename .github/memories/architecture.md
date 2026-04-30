# Architecture

- The API service is the only client-facing HTTP surface: it exposes `GET /ready`, `POST /tasks/run` (legacy direct run), and `POST /v1/chat/completions` (OpenAI-compatible streaming), maintains the in-memory request queue, and accepts worker connections on `/ws/workers`.
- Worker containers do not handle client stream requests directly; they keep persistent outbound WebSocket connections to the API and receive queued jobs there.
- Thin composition root: `api/app.js` only wires middleware, mounts `routes/`, registers `/ready`, adds 404 and terminal error handlers, and calls `bootstrap()`. No inline request handlers belong in `app.js`.
- HTTP handlers live in `api/routes/*.js` as named `router` exports (`export const router = express.Router()`); each route file is mounted by `app.js` at its prefix.
- Routers stay thin and limited to request/response orchestration.
- Models are the exclusive owners of entity business logic and are the layer that triggers persistence through MySQL driver methods.
- Entity business logic must not be implemented in routers, helpers, middleware, or the MySQL driver.
- Helpers are limited to cross-entity/non-entity domain behavior.
- MySQL driver remains generic and reusable; keep business-specific policy out of driver methods.
- `api/app.js` exports `app`, `server` (the Node.js HTTP server returned by `app.listen()`), and `streamRouter`. The `server` export is required by integration tests.
- Tests are split into `api/test/` (unit + integration) and `worker/test/` (unit + integration). Both use Node.js built-in `node:test` with `.mjs` files.
- Compose topology: `api/compose.yaml` starts the API on port 80:3000; `worker/compose.dev.yaml` starts workers with no published ports on the external `llm` bridge network.
- Favor clean current architecture over legacy compatibility patching because this project is not launched yet.

## Worker Binding and Persistence Architecture

- Workers bind to users via API key validation on the `/ws/workers` handshake. The worker sends its `workerId` and the user's `apiKey` in the `worker-register` message.
- `StreamRouter.registerWorker()` invokes `WorkersModel.bindConnectedWorker()` to validate the API key and upsert the worker into the `workers` table with immutable `user_id` ownership.
- Worker-to-user binding is immutable: the `user_id` is set only on initial insert; updates only refresh `status`, `connected_at`, `disconnected_at`, and `last_seen_at`. This prevents worker hijacking under concurrent registration by different API keys.
- The `workers` table schema includes ownership (`user_id`) and status tracking (`connected`, `disconnected`); indexes on `user_id`, `status`, and `(user_id, status)` enable fast queries during matching.
- Orders reference `worker_id` and retain their own `user_id` ownership; both the order creator (provider) and order consumer (client) must be distinct users (no self-orders).

## Order Execution and Settlement Flow

- Orders are execution records, not standing listings. Creation binds a worker immediately for the requested job context.
- OpenAI-compatible requests (`POST /v1/chat/completions`) auto-select a compatible available worker offer, create an internal order, consume it for use, and enqueue the job to that worker.
- Billing is settled at completion time from token usage (`price_per_million * total_tokens / 1_000_000`) rather than pre-debit at order creation.
- Settlement applies configurable platform fee percentage and transfers worker earnings after validating requester/order ownership coherence inside the transaction.
- On job abort before completion, compensating refund/unconsume logic restores order and credit state.
