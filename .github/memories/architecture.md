# Architecture

- The API service is the only client-facing HTTP surface: it exposes `GET /ready` and `POST /stream`, maintains the in-memory request queue, and accepts worker connections on `/ws/workers`.
- Worker containers do not handle client stream requests directly; they keep persistent outbound WebSocket connections to the API and receive queued jobs there.
- Thin composition root: `api/app.js` only wires middleware, mounts `routes/`, registers `/ready`, adds 404 and terminal error handlers, and calls `bootstrap()`. No inline request handlers belong in `app.js`.
- HTTP handlers live in `api/routes/*.js` as named `router` exports (`export const router = express.Router()`); each route file is mounted by `app.js` at its prefix.
