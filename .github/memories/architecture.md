# Architecture

- The API service is the only client-facing HTTP surface: it exposes `GET /ready` and `POST /stream`, maintains the in-memory request queue, and accepts worker connections on `/ws/workers`.
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
