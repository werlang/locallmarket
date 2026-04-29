# Patterns

- In compose development, each worker replica needs its own mounted `/app/node_modules` volume plus package-lock-aware dependency hydration to avoid stale shared dependencies and cross-replica install races.
- Keep SQL statements isolated under `api/drivers/mysql/` and expose persistence through driver methods only; routers/helpers/models must not embed SQL.
- For owner-scoped orderbook APIs, resolve identity from `x-user-external-id` in helpers and enforce ownership in model methods before mutating orders.
- Compute public order availability by combining persisted order state with live worker connectivity/availability from `StreamRouter`.
- api1-style success envelopes: use `sendSuccess(res, data)` and `sendCreated(res, data)` from `api/helpers/response.js` for all 2xx JSON responses; never build raw `res.json()` response objects in route handlers.
- All error cases throw or pass `new HttpError(statusCode, message)`; `errorMiddleware` in `api/middleware/error.js` is the sole terminal Express error handler.
- `POST /stream` is dual-mode: body with `orderId` → `applyOrderUseStream` (consume targeted order); body without `orderId` → `applyLegacyStream` (enqueue via model). Both branches live in `api/routes/stream.js`.
- Owner identity resolved from `x-user-external-id` request header via helper functions; never extracted inline in route handlers.
- Reference projects for this codebase live at `.github/references/` (api0–api3, skills0–skills1); always inspect the relevant reference before implementing a new API feature.
