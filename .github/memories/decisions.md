# Decisions

- The worker package uses Node's built-in `node --test` runner as the active harness for the current ESM stream/WebSocket test suite; obsolete Jest/Babel config was removed.
- The API package also uses Node's built-in `node --test` runner (`npm test`) for helper/model/driver coverage, including SQL-confinement checks.
- `api1` is the selected reference profile for this project's Express organization: thin `app.js` composition root, named `router` exports in `routes/`, `sendSuccess`/`sendCreated` envelope helpers, `HttpError` + `errorMiddleware` for errors, owner identity from `x-user-external-id`. See `.github/references/api1/` for the canonical example.
- Before implementing any new API feature, consult `.github/references/` (especially `api1`) and the `skills1` skill files for established patterns. Do not inline behavior that the reference profile places in helpers, models, or drivers.
- Schema creation/evolution is handled by explicit SQL scripts/migrations run outside runtime. Do not add app-startup schema patching or auto-DDL flows.
- Database access must use MySQL driver methods only; raw SQL in routes/helpers/models/middleware is disallowed.
- Entity business logic is exclusively owned by models; helpers are limited to cross-entity/non-entity logic, and routers/middleware/driver must not implement entity business logic.
- When asked to follow reference projects, apply `.github/references/` guidance strictly (default profile remains `api1`).
- Both `api/` and `worker/` use `node:test` with `--test-reporter=spec` and glob patterns in `package.json` scripts (`test`, `test:unit`, `test:integration`). No external test libraries.
- Project skills are stored in `.github/skills/<skill-name>/SKILL.md`. New skills should be placed there rather than relying only on user-level `~/.copilot/skills/`.
- **Worker persistence and API key binding** (decision implemented in T01): Workers are bound to users via validated API key on the `/ws/workers` WebSocket handshake. The binding is stored in the `workers` table with immutable `user_id` ownership (set once on insert, never updated). This design prevents worker hijacking under concurrent registration attempts and enforces strict ownership separation between users. The immutability constraint is implemented at the model layer: `WorkersModel.bindConnectedWorker()` only updates status/timestamp fields on reconnect, never the owner field. Index structures (`user_id`, `status`, `(user_id, status)`) enable efficient availability queries during order matching.
- Orders are treated as execution records bound to a worker at creation time; legacy standing-order market matching and manual order-management endpoints are removed from the active API surface.
- Completion-time billing is the authoritative accounting model: total cost is computed from token usage and model price-per-million at job completion, then split by `PLATFORM_FEE_PERCENT` between platform retention and worker-owner earnings.
- Settlement transactions must verify requester identity matches the consumed order owner before credit mutations to prevent debit mismatch under stale or malformed settlement metadata.
- Worker identity continuity uses a signed `WORKER_TOKEN` provided by each worker during `worker-register`; missing or invalid tokens mint a new worker identity, while valid tokens reconnect to existing identity records.
