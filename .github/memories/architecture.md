# Architecture

- The API service is the only client-facing HTTP surface: it exposes `GET /ready` and `POST /stream`, maintains the in-memory request queue, and accepts worker connections on `/ws/workers`.
- Worker containers do not handle client stream requests directly; they keep persistent outbound WebSocket connections to the API and receive queued jobs there.
