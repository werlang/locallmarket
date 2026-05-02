# Patterns

## Route Organization

- **Direct Exports**: `api/routes/users.js` exports `const router = express.Router()`
- **Factory Functions**: `api/routes/tasks.js`, `api/routes/workers.js`, `api/routes/openai.js` export factories
  - Example: `export function tasksRouterFactory({ streamRouter }) { ... }`
  - Allows dependency injection of `StreamRouter`, models, helpers
- **Consistency Gap**: Mixed styles should be reconciled in future refactoring
- Routes stay thin: parse request → call model → send response (orchestration only)

## Response Envelopes (api1 style)

- **Success**: `{ ok: true, body: ... }` via `sendSuccess(res, data)` (200 status)
- **Created**: `{ ok: true, body: ... }` via `sendCreated(res, data)` (201 status)
- **Errors**: Throw `new HttpError(statusCode, message)`; caught by `errorMiddleware`
- **Never**: Build raw `res.json()` objects in route handlers
- **Example**: `throw new HttpError(409, 'No workers available for model')`

## Model Layer Ownership

- **Models own entity business logic** (users, workers, orders)
- Routers, helpers, middleware, driver must NOT implement entity logic
- Models invoke persistence through driver methods only
- Example: `WorkersModel.bindConnectedWorker()` validates + upserts; `UsersModel.chargeCredits()` enforces balance rules

## SQL Confinement Pattern

- **All SQL lives in**: `api/helpers/mysql.js` (MySQL driver)
- **Driver exports**: Generic methods: `find()`, `insert()`, `update()`, `upsert()`, `raw()`
- **No raw SQL** in routes, models, helpers, or middleware
- **If new query needed**: Add generic driver method, not inline SQL
- **Driver constraint**: Keep methods business-agnostic; no policy logic

## Testing Patterns

- **Framework**: Node.js built-in `node:test` (no external libraries)
- **File Extensions**: `.mjs` for all test files
- **Structure**: `api/test/unit/`, `api/test/models/`, `api/test/routes/`, `api/test/helpers/`, `api/test/drivers/`
- **Named Exports Only**: `export class Foo {}` (never default exports)
  - Test imports: `import { Foo } from './file.js'`
- **Fakes/Mocks**:
  - `FakeSocket`: minimal `{ readyState, send() }`
  - `FakeWSServer`: for worker testing
  - Stub MySQL driver with `{ raw(), upsert(), update(), findOne(), ... }`
  - Mock `global.fetch` for LLM tests
- **Assertions**: `node:assert/strict` with descriptive messages
  - `assert.equal(actual, expected, 'should verify...')`
- **Integration Tests**: Use `PORT='0'` and `API_WS_PORT='0'` before importing `api/app.js` for OS-assigned ports
  - Import `server` export for cleanup: `server.close()`

## Worker Binding Immutability

- Worker `user_id` set once on initial insert into `workers` table
- **Never updated on reconnect** — only `status`, `connected_at`, `disconnected_at`, `last_seen_at` change
- **Security**: Prevents worker hijacking via concurrent registration with different API keys
- **Implementation**: `WorkersModel.bindConnectedWorker()` must enforce immutability in upsert logic
- **Post-upsert Check**: Verify persisted `user_id` matches expected owner; reject if mismatch

## Error Handling Contract

- Routers/models/helpers throw `HttpError(statusCode, message)` or `Error`
- `errorMiddleware` in `api/middleware/error.js` catches and formats:
  - `HttpError` → `{ ok: false, error: { code, message } }` with appropriate status
  - Other errors → 500 with safe message
- **Terminal Handler**: Express error handler must be last middleware

## Worker Session Management

- Each worker maintains one active WebSocket connection to API
- Runtime events (job-dispatch, chunk, completion) tied to active socket session
- **Stale Event Protection**: Replaced-socket events must not update worker state
  - Late chunks from disconnected socket should be ignored
  - Completion/failure from old socket should not mark new socket's job completed
- Active job tracking per socket prevents cross-socket state corruption

## OpenAI Surface Conventions

- Shared dispatch path for auth, worker selection, queue, receipt lifecycle
- Endpoint-specific behavior limited to: payload normalization, stream-event translation
- **No Self-Orders**: Consumer ≠ worker owner; enforce in model before order creation
- **Ownership Coherence**: Before trusting worker price/tps, verify offer owner matches worker owner
  - Prevents spoofed or stale off-owner rows from influencing selection

## Developer Integration

- Reference projects at `.github/references/` (api0–api3 for Express patterns)
- **Always consult** `.github/references/api1/` before implementing new API features
- When removing endpoints: also remove/update stale tests, verify cleanup with grep
- Favor clean architecture over legacy compatibility patches (project not launched yet)
