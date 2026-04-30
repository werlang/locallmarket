---
name: api-development
description: Build and maintain the API and Worker services for this LLM streaming relay project. Use when adding or modifying routes, request validation, SSE relay logic, queue behavior, WebSocket server events, or LLM model runner integration.
---

# API Development

## Service Overview

Two services cooperate to relay LLM completions from a model runner to HTTP clients as Server-Sent Events:

- **`api/`** — Express HTTP server. Accepts client stream requests, queues them, and dispatches to a registered worker via WebSocket. Relays SSE chunks back to the waiting client.
- **`worker/`** — Express HTTP health server + outbound WebSocket client. Receives job payloads from the API, calls the LLM model runner, and sends stream events back through the socket.

## API Shape (`api/`)

Base app: `api/app.js`

Global middleware: `express.json()`, `express.urlencoded()`, terminal error middleware.

Routes:
- `GET /ready` — health check; returns queue and worker capacity
- `POST /stream` — accepts a client LLM request; relays SSE back

### `GET /ready` Response

```json
{
  "ok": true,
  "connectedWorkers": 1,
  "availableWorkers": 1,
  "activeJobs": 0,
  "queuedJobs": 0
}
```

### `POST /stream` Contract

Request body:
```json
{ "message": "Hello", "model": "ai/smollm2" }
```
(`input` is accepted as an alias for `message`)

Validation errors (`400`):
- `message` missing or not a non-empty string
- `model` missing or not a non-empty string

Response: `text/event-stream` SSE with events:
- `event: message` — each LLM output chunk (`data: <text>`)
- `event: end` — completion signal (`data: Stream complete.`)
- `event: error` — relay error (`data: <message>`)

### Error Envelope

All JSON errors use:
```json
{ "error": true, "status": 400, "type": "Bad Request", "message": "..." }
```

`api/middleware/error.js` derives `type` from HTTP status names.

## Key API Code Paths

| File | Responsibility |
|---|---|
| `api/helpers/queue.js` | `Queue` — FIFO job queue with add/requeue/shift/remove/getPosition |
| `api/helpers/router.js` | `StreamRouter` — dispatches queued jobs to available workers; tracks active jobs; handles worker lifecycle |
| `api/helpers/stream.js` | `HttpStream` — SSE response wrapper (event name, send, close) |
| `api/helpers/wsserver.js` | `WSServer` — WebSocket server wrapper; parses typed messages; routes to registered handlers |
| `api/helpers/error.js` | `HttpError`, `CustomError` — typed error classes |
| `api/middleware/error.js` | Terminal error middleware; formats error envelope |

## Worker Shape (`worker/`)

Base app: `worker/app.js`

Routes:
- `GET /ready` — returns `{ ok: true, message, timestamp, uptime }`

The worker does **not** expose the LLM port or accept HTTP stream requests. All work flows through the WebSocket connection to the API.

## Key Worker Code Paths

| File | Responsibility |
|---|---|
| `worker/helpers/api-client.js` | `ApiStreamClient` — persistent WebSocket connection to API; registers worker; handles job-dispatch messages; calls LLM; sends stream events back; reconnects with exponential backoff |
| `worker/model/llm.js` | `LLM` — calls LLM model runner via `fetch` SSE; forwards chunks to a `SocketStream`; throws `HttpError` on failure |
| `worker/routes/system.js` | Express router for `GET /ready` |
| `worker/helpers/error.js` | `HttpError`, `CustomError` |
| `worker/middleware/error.js` | Terminal error middleware |

## WebSocket Protocol (API ↔ Worker)

All messages are JSON: `{ "type": "<event>", "payload": { ... } }`.

Worker → API:
- `worker-register` — `{ workerId, hostname, pid }`
- `worker-ready` — signals availability after completing a job
- `stream-event` — `{ jobId, event, data }` (relays LLM output chunk)
- `job-complete` — `{ jobId }`
- `job-failed` — `{ jobId, error }`

API → Worker:
- `job-dispatch` — `{ jobId, message, model }`
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

## Architecture Guardrails (Mandatory)

1. Never create or patch schema from live application code. Use explicit SQL scripts/migrations only, executed outside app startup.
2. Never write raw SQL outside the MySQL driver module (`api/helpers/mysql.js`).
3. If persistence behavior is missing, add a new generic MySQL driver method and call it from models.
4. Keep MySQL driver logic generic and reusable; do not place business/domain policy in driver methods.
5. Models are the exclusive owners of entity business logic. Entity business logic must not be implemented in routers, helpers, middleware, or the MySQL driver.
6. Routers must stay thin (request/response orchestration only). Helpers are limited to cross-entity/non-entity logic such as pricing or worker availability.
7. Favor clean current architecture over legacy compatibility patches for this pre-launch project.
8. When requested to follow references, treat `.github/references/` (especially `api1`) as strict standards.

## Conventions

- ESM only — `"type": "module"` in both `package.json` files; use `import`/`export` throughout.
- Node.js 22+; no transpilation, no Babel.
- MySQL usage follows driver-method boundaries and migration-only schema management.
- Keep HTTP surface limited to `GET` and `POST`; avoid `PUT`/`PATCH`/`DELETE` unless clearly required.
- Propagate errors to `next(error)` in route handlers; let `errorMiddleware` format the response.
