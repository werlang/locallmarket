# Architecture

- The API service is the only client-facing HTTP surface: it exposes `GET /ready` and `POST /stream`, maintains the in-memory request queue, and accepts worker connections on `/ws/workers`.
- Worker containers do not handle client stream requests directly; they keep persistent outbound WebSocket connections to the API and receive queued jobs there.
- `api/app.js` exports `app`, `server` (the Node.js HTTP server returned by `app.listen()`), and `streamRouter`. The `server` export is required by integration tests.
- Tests are split into `api/test/` (unit + integration) and `worker/test/` (unit + integration). Both use Node.js built-in `node:test` with `.mjs` files.
- Compose topology: `api/compose.yaml` starts the API on port 80:3000; `worker/compose.dev.yaml` starts workers with no published ports on the external `llm` bridge network.
