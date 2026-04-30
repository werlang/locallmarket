# Patterns

- In compose development, each worker replica needs its own mounted `/app/node_modules` volume plus package-lock-aware dependency hydration to avoid stale shared dependencies and cross-replica install races.
- Keep SQL isolated inside the MySQL driver module (`api/helpers/mysql.js`) and expose persistence through public driver methods only; no raw SQL in routers/helpers/models/middleware.
- If a query is needed and no driver method exists, add a new generic driver method instead of inlining SQL in model/helper/route code.
- Keep MySQL driver methods business-agnostic.
- Entity business logic is exclusively owned by models and must not be implemented in routers/helpers/middleware/driver.
- Helpers are limited to cross-entity/non-entity business logic.
- For API-key scoped execution APIs, resolve requester identity from bearer API key and enforce ownership in model transactions before mutating orders or credits.
- api1-style success envelopes: use `sendSuccess(res, data)` and `sendCreated(res, data)` from `api/helpers/response.js` for all 2xx JSON responses; never build raw `res.json()` response objects in route handlers.
- All error cases throw or pass `new HttpError(statusCode, message)`; `errorMiddleware` in `api/middleware/error.js` is the sole terminal Express error handler.
- `POST /tasks/run` remains the direct-run route for simple message/model payloads; OpenAI-compatible streaming uses `POST /v1/chat/completions` with `stream: true`.
- OpenAI auto-match selection must enforce offer/worker ownership coherence before trusting price metadata to avoid spoofed or stale off-owner offer influence.
- When removing legacy endpoints/routes, remove or rewrite stale tests that import deleted modules in the same task and verify cleanup with a repository grep.
- Reference projects for this codebase live at `.github/references/` (api0–api3, skills0–skills1); always inspect the relevant reference before implementing a new API feature.
- Integration tests that need the API HTTP server use `process.env.PORT = '0'` and `process.env.API_WS_PORT = '0'` before importing `api/app.js` to get OS-assigned ports. The exported `server` reference is used for cleanup (`server.close()`).
- Worker unit tests isolate network with `FakeSocket` and `FakeWSServer` classes defined inline. API client tests use a minimal fake `WebSocket` with `.send()` and `.readyState` properties. LLM tests mock `global.fetch`.
- Named exports only: all classes use `export class Foo {}` — never `export default`. Test files must use `import { Foo } from ...` not `import Foo from ...`.
