# Patterns

- In compose development, each worker replica needs its own mounted `/app/node_modules` volume plus package-lock-aware dependency hydration to avoid stale shared dependencies and cross-replica install races.
- Keep SQL isolated inside the MySQL driver module (`api/helpers/mysql.js`) and expose persistence through public driver methods only; no raw SQL in routers/helpers/models/middleware.
- If a query is needed and no driver method exists, add a new generic driver method instead of inlining SQL in model/helper/route code.
- Keep MySQL driver methods business-agnostic.
- Entity business logic is exclusively owned by models and must not be implemented in routers/helpers/middleware/driver.
- Helpers are limited to cross-entity/non-entity business logic.
- For owner-scoped orderbook APIs, resolve identity from `x-user-external-id` in helpers and enforce ownership in model methods before mutating orders.
- Compute public order availability by combining persisted order state with live worker connectivity/availability from `StreamRouter`.
- api1-style success envelopes: use `sendSuccess(res, data)` and `sendCreated(res, data)` from `api/helpers/response.js` for all 2xx JSON responses; never build raw `res.json()` response objects in route handlers.
- All error cases throw or pass `new HttpError(statusCode, message)`; `errorMiddleware` in `api/middleware/error.js` is the sole terminal Express error handler.
- `POST /stream` is dual-mode: body with `orderId` → `applyOrderUseStream` (consume targeted order); body without `orderId` → `applyLegacyStream` (enqueue via model). Both branches live in `api/routes/stream.js`.
- Owner identity resolved from `x-user-external-id` request header via helper functions; never extracted inline in route handlers.
- Reference projects for this codebase live at `.github/references/` (api0–api3, skills0–skills1); always inspect the relevant reference before implementing a new API feature.
- Integration tests that need the API HTTP server use `process.env.PORT = '0'` and `process.env.API_WS_PORT = '0'` before importing `api/app.js` to get OS-assigned ports. The exported `server` reference is used for cleanup (`server.close()`).
- Worker unit tests isolate network with `FakeSocket` and `FakeWSServer` classes defined inline. API client tests use a minimal fake `WebSocket` with `.send()` and `.readyState` properties. LLM tests mock `global.fetch`.
- Named exports only: all classes use `export class Foo {}` — never `export default`. Test files must use `import { Foo } from ...` not `import Foo from ...`.
