# LocalLMarket Project Instructions

**Last Updated**: May 2, 2026  
**Scope**: API service (`api/`), Worker service (`worker/`), and test infrastructure  
**Reference Profile**: `.github/references/api1/` (Express architecture conventions)

---

## 1. Project Overview

LocalLMarket is a peer-to-peer marketplace for renting LLM compute capacity. Users (consumers) submit language model requests to a distributed pool of worker nodes; workers execute jobs and stream results back through the API. Pricing is dynamic, based on worker-offered rates (price per token, tokens-per-second throughput). The system is built for decentralized trust and transparent billing.

**Core Purpose**:
- Aggregate worker capacity from independent operators
- Match consumer requests to available workers by price and throughput
- Execute LLM jobs with real-time streaming and transparent settlement
- Maintain immutable ownership bindings and encrypted credentials for security

**Key Constraint**: The system operates without central verification of worker execution; security relies on transparent pricing, operator reputation, and immutable bindings.

---

## 2. Architectural Principles

### 2.1 Service Topology

- **API Service** (`api/app.js`): Express HTTP server + WebSocket listener for inbound worker registration
- **Worker Service** (`worker/app.js`): Outbound WebSocket client; no inbound HTTP surface
- **MySQL** (optional): Persistent store controlled by `MYSQL_ENABLED` environment variable

**Why this shape**: API owns the authentication and authorization boundary. Workers are consumers of the job queue; they do not provide services to external clients directly. This centralizes credential validation and order matching logic.

### 2.2 Layer Ownership

| Layer | Responsibility | Example |
|-------|---|---|
| **Routes** | HTTP orchestration only: parse, validate, call model, return response | `routes/users.js`: register user, return API key |
| **Models** | Entity business logic: validation, state transitions, persistence calls | `UsersModel.register()`: email check, key generation, DB insert |
| **Helpers** | Cross-entity utilities: auth resolution, stream relay, error formatting | `helpers/auth.js`: bearer token parsing |
| **Driver** | Generic SQL methods only (find, insert, update, upsert); zero business logic | `Mysql.insert()`: generic INSERT wrapper |
| **Middleware** | Express middleware: error handler is terminal catch-all | `middleware/error.js`: format all errors |

**Non-Negotiable**: Business logic never leaks into routes, helpers, middleware, or driver. If a model needs a query, add a driver method first.

### 2.3 Persistence Strategy

- **MySQL is optional**: Enabled via `MYSQL_ENABLED=true`; when disabled, ephemeral in-memory state
- **Immutable Bindings**: Worker `user_id` set on first insert, never updated on reconnect
- **Encryption at Rest**: API keys stored encrypted (AES-256-GCM) + HMAC lookup hash (prevents breach leakage)
- **No Runtime Schema Patching**: Schema changes use explicit SQL migrations, not app-startup `ALTER TABLE` statements

### 2.4 Security-First Principles

- Worker binding is immutable to prevent hijacking under concurrent registration attempts
- API keys encrypted to protect against database compromise
- No self-orders: consumers cannot profit from their own worker's capacity
- Ownership always re-validated after concurrent mutations (post-upsert checks)

### 2.5 Testing Philosophy

- **Framework**: Node.js built-in `node:test` only (no Jest, Mocha, Vitest)
- **Module System**: ESM with `.mjs` files and named exports exclusively
- **Isolation**: Unit tests mock/stub; integration tests use OS-assigned ports
- **Regression Prevention**: Deterministic tests verify the fix, not just happy path

---

## 3. Code Organization

### 3.1 Directory Structure

```
api/
├── app.js                 # Composition root: middleware, routes, exports
├── compose.yaml           # Docker compose configuration
├── schema.sql             # Database schema; updated via explicit migrations
├── package.json           # Dependencies
├── routes/                # HTTP orchestration (thin layer)
│   ├── users.js           # User registration, profile, direct export
│   ├── tasks.js           # Job dispatch, factory pattern
│   ├── workers.js         # Worker CRUD, factory pattern
│   ├── orders.js          # Order history, direct export
│   └── openai.js          # OpenAI compatibility endpoint, factory pattern
├── models/                # Business logic (thick layer)
│   ├── users.js           # User validation, key generation, registration
│   ├── workers.js         # Worker binding, immutability checks, status
│   └── orders.js          # Order creation, settlement, matching
├── helpers/               # Cross-entity utilities
│   ├── mysql.js           # SQL driver: all queries live here
│   ├── auth.js            # Bearer token parsing, key decryption
│   ├── response.js        # sendSuccess(), sendCreated() envelopes
│   ├── secure-key.js      # API key encryption, HMAC hashing
│   ├── stream.js          # SSE client, chunk relay
│   ├── router.js          # StreamRouter job queue and dispatch
│   ├── wsserver.js        # WebSocket server with typed message handlers
│   ├── error.js           # HttpError class
│   └── queue.js           # Job queue primitives
├── middleware/
│   └── error.js           # Express error handler (terminal)
└── test/
    ├── unit/              # Isolated component tests
    ├── models/            # Model business logic tests
    ├── routes/            # Route orchestration tests
    ├── helpers/           # Helper utility tests
    ├── drivers/           # MySQL driver contract tests
    └── integration/       # Full app tests (reserved)

worker/
├── app.js                 # Worker client app
├── helpers/
│   ├── api-client.js      # WebSocket client library
│   └── llm.js             # LLM execution runner
└── test/
    ├── unit/              # Component tests
    └── integration/       # Stream API tests
```

### 3.2 File Patterns

**Composition Root** (`api/app.js`):
- Construct all dependencies (models, helpers, WSServer, StreamRouter)
- Wire routes with factories for dependency injection
- Export `app`, `server`, `streamRouter` for tests and runtime
- Keep middleware wiring to 50 lines max

**Routes**:
- **Direct Export**: `export const router = express.Router()` (e.g., `users.js`, `orders.js`)
- **Factory Export**: `export function tasksRouterFactory({ streamRouter }) { ... }` (e.g., `tasks.js`)
- Prefer **factory pattern for new routes** (better testability and dependency clarity)
- Each route file is at most 100 lines

**Models**:
- Class with `static` methods or instance methods
- Example: `export class UsersModel { static register() { ... } }`
- One model per entity; models own all validation, state transitions, and persistence calls
- Models call driver methods only; never raw SQL

**Helpers**:
- Reusable across multiple models
- Example: `auth.js` for bearer token resolution (used by multiple routes)
- Non-business-logic utilities (formatting, encryption, stream handling)

---

## 4. SQL & Persistence: Single Confinement Pattern

### 4.1 The Rule

**All SQL queries live in `api/helpers/mysql.js` and nowhere else.**

- No raw SQL in routes, models, helpers, middleware, or tests (except driver tests)
- If a query is needed, add a public driver method to `mysql.js` first
- Driver methods are business-agnostic: `find()`, `insert()`, `update()`, `upsert()`, `raw()`

### 4.2 Example: Adding a New Query

**Scenario**: Models need to find workers by user and status.

✅ **Correct Approach**:

```javascript
// api/helpers/mysql.js
export class Mysql {
    static async find(table, {
        filter = {}, 
        view = ['*'], 
        opt = {} 
    } = {}) {
        // Generic find method, business-logic-free
        const placeholders = Object.entries(filter)
            .map(([k, v]) => `${Mysql.#quoteIdentifier(k)} = ?`)
            .join(' AND ');
        
        const sql = `SELECT ${view.join(',')} FROM ${Mysql.#quoteIdentifier(table)} 
                     ${placeholders ? 'WHERE ' + placeholders : ''} 
                     LIMIT ${opt.limit || 1000}`;
        
        const values = Object.values(filter);
        const [rows] = await Mysql.connection.execute(sql, values);
        return rows;
    }
}

// api/models/workers.js
static async getByUserAndStatus(userId, status) {
    const workers = await Mysql.find('workers', {
        filter: { user_id: userId, status },
        view: ['id', 'model', 'tps', 'price']
    });
    return workers;
}
```

❌ **Never do this**:
- Build SQL in models: `const sql = SELECT * FROM workers WHERE ...`
- Add business logic in driver: `Mysql.getAvailableForConsumer()` (domain logic)
- Use raw SQL in routes: `db.query('SELECT ...')`

### 4.3 Schema Management

- Schema defined in `api/schema.sql`
- Schema changes made via explicit SQL migration scripts
- No runtime `ALTER TABLE` at app startup (except for temporary dev-only conveniences)
- Test database uses `${ORIGINAL_DB}_test_${TEST_DATABASE_ID}` naming convention

### 4.4 Rationale

- **Testability**: Mock driver returns predictable data; no flaky SQL or dependency on test DB schema
- **Security**: Centralized escaping and sanitization; single place to verify SQL injection prevention
- **Maintainability**: When SQL breaks, changes are in one file
- **Clarity**: New developers know exactly where queries live

---

## 5. Models & Business Logic

### 5.1 Model Ownership

Models are the **exclusive owners** of entity business logic:
- ✅ Validation (email format, price bounds, enum checks)
- ✅ State transitions (worker status: connected → disconnected)
- ✅ Constraints (no self-orders: requester ≠ worker owner)
- ✅ Calculations (reputation score from uptime percentage)
- ✅ Persistence orchestration (call driver methods in sequence)

**What models must NOT do**:
- ❌ HTTP orchestration (parse query params, set status codes)
- ❌ Cross-entity logic (this belongs in helpers or route orchestration)
- ❌ Encryption/auth (call helpers; don't implement)

### 5.2 Example: Model Business Logic

```javascript
// api/models/users.js
export class UsersModel {
    /**
     * Registers a new user with email validation and auto-generated API key.
     * Throws HttpError on validation failure or conflicts.
     */
    static async register(input) {
        // Validation: business logic
        if (input.email && !EMAIL_REGEX.test(input.email)) {
            throw new HttpError(400, 'Invalid email format.');
        }

        // Conflict check: business logic (prevent duplicate emails)
        if (input.email) {
            const existing = await Mysql.findOne('users', {
                filter: { email: input.email }
            });
            if (existing) {
                throw new HttpError(409, 'A user with this email already exists.');
            }
        }

        // Key generation: business logic (retry on collision)
        const apiKey = generateApiKey();
        const record = {
            id: randomUUID(),
            ...createApiKeyRecord(apiKey), // encryption helper
            ...input
        };

        // Persistence: call driver
        await Mysql.insert('users', record);
        const user = await this.getById(record.id);
        return { user, apiKey };
    }

    /**
     * Charge credits from user account. Throws HttpError if insufficient balance.
     */
    static async chargeCredits(userId, amount) {
        const user = await this.getById(userId);

        // Validation: business logic (enforce constraint)
        if (user.credits < amount) {
            throw new HttpError(402, 'Insufficient credits.');
        }

        // Update: persistence call
        const newBalance = user.credits - amount;
        await Mysql.update('users', 
            { id: userId }, 
            { credits: newBalance }
        );
    }
}
```

### 5.3 Anti-Pattern: Business Logic in Routes

❌ **DO NOT WRITE THIS**:
```javascript
// WRONG: Business logic leaking into routes
router.post('/register', async (req, res, next) => {
    // Validation in route (WRONG)
    if (!req.body.email || !EMAIL_REGEX.test(req.body.email)) {
        return sendError(res, 400, 'Invalid email');
    }

    // Duplicate check in route (WRONG)
    const existing = await Mysql.findOne('users', 
        { filter: { email: req.body.email } }
    );
    if (existing) {
        return sendError(res, 409, 'Already exists');
    }

    // Should call model instead
    res.json({ ok: true });
});
```

✅ **CORRECT**: Route calls model
```javascript
router.post('/', async (req, res, next) => {
    try {
        const payload = parseCreateUserBody(req.body);
        const { user, apiKey } = await usersModel.register(payload);
        return sendCreated(res, { body: { user: { ...user, apiKey } } });
    } catch (error) {
        return next(error);
    }
});
```

---

## 6. Routes & HTTP Handling

### 6.1 Route Philosophy

Routes are **thin orchestration layers**. Each route handler:
1. Parse and validate input (or delegate to helper)
2. Call model or helper method
3. Shape response envelope
4. Throw `HttpError` on failure

Routes **must not** implement business logic.

### 6.2 Direct Export vs. Factory Pattern

**Pattern 1: Direct Export** (Simple routes with no dependencies)
```javascript
// api/routes/users.js
import express from 'express';
import { usersModel } from '../models/users.js';

export const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const { user, apiKey } = await usersModel.register(req.body);
        return sendCreated(res, { body: { user: { ...user, apiKey } } });
    } catch (error) {
        return next(error);
    }
});
```

**Pattern 2: Factory Function** (Routes that need dependency injection)
```javascript
// api/routes/tasks.js — requires StreamRouter
export function tasksRouterFactory({ streamRouter }) {
    const router = express.Router();

    router.post('/run', async (req, res, next) => {
        try {
            const payload = parseLegacyStreamBody(req.body);
            const stream = new HttpStream(res);
            const jobId = streamRouter.enqueue({ payload, stream });
            
            res.once('close', () => {
                streamRouter.cancel(jobId);
            });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}
```

**Recommendation**: Use **factory pattern for all new routes**. It enables:
- Explicit dependency injection (improved testability)
- Clear parameter requirements (self-documenting)
- Easier mocking in tests

### 6.3 Input Parsing & Validation

Input validation helpers (e.g., `helpers/users.js`, `helpers/orders.js`) parse and throw `HttpError`:

```javascript
// api/helpers/users.js
export function parseCreateUserBody(body) {
    if (!body || typeof body !== 'object') {
        throw new HttpError(400, 'Request body must be an object.');
    }

    const { name, email } = body;

    if (email !== undefined && typeof email !== 'string') {
        throw new HttpError(400, 'Email must be a string.');
    }

    return { name, email };
}
```

### 6.4 Response Shaping

Use `sendSuccess()` and `sendCreated()` from `helpers/response.js`:

```javascript
// Success (200)
return sendSuccess(res, { body: { user } });

// Created (201)
return sendCreated(res, { body: { user: { ...user, apiKey } } });

// Error (via HttpError thrown and caught by errorMiddleware)
throw new HttpError(404, 'User not found.');
```

---

## 7. Response Envelopes & Error Handling

### 7.1 Response Contract (api1 style)

**Success** (200):
```json
{ "ok": true, "body": { "user": { "id": "...", "name": "..." } } }
```

**Created** (201):
```json
{ "ok": true, "body": { "user": { "id": "...", "name": "..." }, "apiKey": "..." } }
```

**Error** (4xx, 5xx):
```json
{
    "ok": false,
    "error": {
        "code": 400,
        "message": "Invalid email format."
    }
}
```

### 7.2 Error Flow

**Routes throw `HttpError`**:
```javascript
throw new HttpError(409, 'A user with this email already exists.');
```

**`errorMiddleware` catches and formats**:
```javascript
// api/middleware/error.js
export function errorMiddleware(err, req, res, next) {
    if (err instanceof HttpError) {
        return res.status(err.code).json({
            ok: false,
            error: { code: err.code, message: err.message }
        });
    }

    // Unexpected errors → 500
    console.error(err);
    return res.status(500).json({
        ok: false,
        error: { code: 500, message: 'Internal server error' }
    });
}
```

**Error middleware must be the last middleware** in `app.js`:
```javascript
app.use(errorMiddleware); // Last line
```

### 7.3 HttpError Class

```javascript
// api/helpers/error.js
export class HttpError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'HttpError';
    }
}
```

---

## 8. Authentication & Authorization

### 8.1 API Key Format & Storage

- **Format**: 64-character random hex string (`randomBytes(32).toString('hex')`)
- **Storage**: Encrypted AES-256-GCM ciphertext + HMAC-SHA256 lookup hash
- **Lookup**: Bearer token decrypted and compared to stored ciphertext (or hash-based indexed lookup)
- **Encryption Secret**: `API_KEY_ENCRYPTION_SECRET` environment variable (stable across app restarts)

### 8.2 Bearer Token Resolution

```javascript
// api/helpers/auth.js
export function parseBearerApiKey(headers) {
    const authHeader = headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);

    if (!match || !match[1]) {
        throw new HttpError(401, 'Missing or invalid Bearer token.');
    }

    return match[1]; // Return 64-char hex key
}

// Used in models to resolve user
static async getByApiKey(apiKey) {
    const lookupHash = computeApiKeyLookupHash(apiKey);
    const user = await Mysql.findOne('users', 
        { filter: { api_key_lookup_hash: lookupHash } }
    );

    if (!user) {
        throw new HttpError(401, 'Invalid API key.');
    }

    return user;
}
```

### 8.3 Authorization: Ownership Validation

Before any mutation, verify the requester owns the resource:

```javascript
router.put('/', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        
        // Enforce ownership before update
        const payload = parseUpdateUserBody(req.body);
        const updatedUser = await usersModel.updateById(user.id, payload);

        return sendSuccess(res, { body: { user: updatedUser } });
    } catch (error) {
        return next(error);
    }
});
```

### 8.4 Worker Binding: Immutable After Registration

```javascript
// api/models/workers.js
static async bindConnectedWorker(workerId, apiKey, metadata) {
    const user = await usersModel.getByApiKey(apiKey);

    // Check for existing binding
    const existing = await Mysql.findOne('workers', 
        { filter: { id: workerId } }
    );

    if (existing) {
        // Immutability check: user_id must match
        if (existing.user_id !== user.id) {
            throw new HttpError(409, 
                'Worker is bound to a different user and cannot be hijacked.'
            );
        }

        // Reconnect: update status only, never user_id
        await Mysql.update('workers', 
            { id: workerId },
            { 
                status: 'connected', 
                connected_at: new Date(),
                last_seen_at: new Date()
            }
        );
    } else {
        // First binding: insert with user_id
        await Mysql.insert('workers', {
            id: workerId,
            user_id: user.id, // Set once, never changed
            ...metadata
        });
    }

    // Post-upsert safety: re-fetch and verify ownership
    const worker = await Mysql.findOne('workers', 
        { filter: { id: workerId } }
    );

    if (worker.user_id !== user.id) {
        throw new HttpError(500, 'Worker binding conflict detected.');
    }

    return worker;
}
```

### 8.5 No Self-Orders Constraint

```javascript
// api/models/orders.js
static async createOrder(consumerId, workerId, jobPayload) {
    const worker = await Mysql.findOne('workers', 
        { filter: { id: workerId } }
    );

    // Enforce: consumer ≠ worker owner
    if (worker.user_id === consumerId) {
        throw new HttpError(400, 'Cannot order from your own worker.');
    }

    // Proceed with order creation
    return Mysql.insert('orders', {
        requester_id: consumerId,
        worker_id: workerId,
        status: 'running',
        ...jobPayload
    });
}
```

---

## 9. WebSocket & Worker Communication

### 9.1 Worker Registration Flow

```
Worker connects to ws://{API_HOST}:{API_WS_PORT}{WORKER_ROUTE}
    ↓
Sends: { type: 'worker-register', payload: { workerId, apiKey, model, tps, price } }
    ↓
API validates API key, binds worker to user
    ↓
Sends: { type: 'worker-token', payload: { token: '...' } }
    ↓
Worker sends: { type: 'worker-ready' }
```

### 9.2 Message Types

**Worker-to-API**:
- `worker-register`: Initial registration with credentials and offer metadata
- `worker-ready`: Worker pool ready to accept jobs
- `stream-event`: LLM output chunk (streamed from worker to consumer)
- `job-complete`: Job finished successfully; includes token usage
- `job-failed`: Job failed; includes error message

**API-to-Worker**:
- `job-dispatch`: Enqueued job payload and execution context
- `worker-token`: Session token (for reconnection validation)

### 9.3 WSServer & Message Handlers

```javascript
// api/helpers/wsserver.js
export class WSServer extends EventEmitter {
    constructor({ port, path }) {
        super();
        this.ws = new WebSocketServer({ port, path });
        this.ws.on('connection', (socket) => {
            socket.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    const { type, payload } = msg;
                    
                    // Emit typed event
                    this.emit(type, socket, payload);
                } catch (e) {
                    // Silently ignore invalid JSON
                }
            });
        });
    }

    /**
     * Register a handler for a specific message type.
     */
    on(type, handler) {
        super.on(type, handler);
    }

    /**
     * Broadcast a message to all connected clients.
     */
    broadcast(type, payload) {
        for (const client of this.ws.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type, payload }));
            }
        }
    }
}
```

### 9.4 Worker Session Safety

Each worker maintains one active WebSocket connection. Events (chunks, completion) tied to that session:

```javascript
// api/helpers/router.js
export class StreamRouter {
    #activeJobs = new Map(); // jobId → { socket, stream, metadata }

    onStreamEvent(socket, { jobId, chunk }) {
        const job = this.#activeJobs.get(jobId);

        // Session safety: discard stale socket events
        if (!job || job.socket !== socket) {
            return; // Ignore events from replaced socket
        }

        // Write chunk to HTTP response stream
        job.stream.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }

    onJobComplete(socket, { jobId, usage }) {
        const job = this.#activeJobs.get(jobId);

        // Session safety: discard stale socket events
        if (!job || job.socket !== socket) {
            return;
        }

        // Settle order, mark completed
        job.stream.end();
        this.#activeJobs.delete(jobId);
    }
}
```

---

## 10. Testing Conventions

### 10.1 Test Framework

- **Runner**: Node.js `node:test` (built-in, no external test library)
- **File Format**: `.mjs` (ECMAScript modules only)
- **Module Style**: Named exports exclusively (`import { Class } from './file.js'`)
- **Assertions**: `node:assert/strict` with descriptive messages
- **Syntax**: `test('description', async (t) => { ... })`

### 10.2 Test Organization

```
api/test/
├── unit/                      # Isolated component tests
│   ├── error.test.mjs
│   ├── mysql.test.mjs
│   ├── wsserver.test.mjs
│   └── stream.test.mjs
├── models/                    # Model business logic tests
│   ├── users.test.mjs
│   ├── workers.test.mjs
│   └── orders.test.mjs
├── routes/                    # Route orchestration tests
│   ├── users.test.mjs
│   ├── tasks.test.mjs
│   └── workers.test.mjs
├── helpers/                   # Helper utility tests
│   ├── auth.test.mjs
│   ├── secure-key.test.mjs
│   └── users.test.mjs
├── drivers/                   # MySQL driver contract tests
└── integration/               # Full app tests (reserved for future use)
```

### 10.3 Unit Test Pattern

```javascript
// api/test/helpers/auth.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBearerApiKey } from '../../helpers/auth.js';
import { HttpError } from '../../helpers/error.js';

describe('parseBearerApiKey', () => {
    it('extracts API key from Bearer header', () => {
        const key = 'a'.repeat(64);
        const headers = { authorization: `Bearer ${key}` };

        const result = parseBearerApiKey(headers);

        assert.equal(result, key);
    });

    it('throws 401 if Bearer token missing', () => {
        const headers = { authorization: 'Basic ...' };

        assert.throws(() => parseBearerApiKey(headers), HttpError);
    });
});
```

### 10.4 Model Test with Stub Driver

```javascript
// api/test/models/users.test.mjs
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Mysql from '../../helpers/mysql.js';
import { UsersModel } from '../../models/users.js';
import { HttpError } from '../../helpers/error.js';

describe('UsersModel.register', () => {
    before(() => {
        // Stub Mysql driver for testing
        Mysql.default = {
            findOne: async () => null, // No existing user
            insert: async () => {}, // Succeeds
        };
    });

    it('generates API key and returns user', async () => {
        const { user, apiKey } = await UsersModel.register({ 
            email: 'test@example.com' 
        });

        assert(user.id);
        assert.match(apiKey, /^[a-f0-9]{64}$/);
    });

    it('throws 400 for invalid email', async () => {
        assert.rejects(() => UsersModel.register({ 
            email: 'not-an-email' 
        }), HttpError);
    });
});
```

### 10.5 Integration Test with Real Ports

```javascript
// api/test/integration/users.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('POST /users (integration)', () => {
    let server;
    let port;

    before(async () => {
        // Use OS-assigned port
        process.env.PORT = '0';
        process.env.API_WS_PORT = '0';

        const { server: srv } = await import('../../app.js');
        server = srv;
        port = server.address().port;
    });

    after(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    it('registers user and returns API key', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com' })
        });

        assert.equal(res.status, 201);
        const { ok, body } = await res.json();
        assert(ok);
        assert(body.user.id);
        assert(body.apiKey);
    });
});
```

### 10.6 Test Naming Conventions

- **Describe**: Feature or class name (`describe('UsersModel', ...)`)
- **Test**: Specific behavior (`it('generates API key and returns user', ...)`)
- **Nested**: Use `await t.test()` for sub-tests when logically grouped
- **Error Cases**: Include expected error or constraint name in description

### 10.7 Mocking Patterns

**Fake WebSocket**:
```javascript
class FakeSocket {
    readyState = WebSocket.OPEN;
    sent = [];

    send(data) {
        this.sent.push(JSON.parse(data));
    }
}
```

**Stub MySQL Driver**:
```javascript
const StubMysql = {
    find: async (table, opts) => [],
    insert: async (table, data) => {},
    update: async (table, filter, data) => {},
    upsert: async (table, filter, data) => ({}),
};
```

---

## 11. Common Patterns

### 11.1 Factory Dependency Injection

Routes and helpers that depend on other services should accept them as constructor or function arguments:

```javascript
// Define factory
export function tasksRouterFactory({ streamRouter, ordersModel }) {
    return express.Router().post('/run', async (req, res) => {
        const jobId = streamRouter.enqueue({ ... });
        // ...
    });
}

// Inject in app.js
const tasksRouter = tasksRouterFactory({ streamRouter, ordersModel });
app.use('/tasks', tasksRouter);
```

### 11.2 Immutable Binding Pattern

Once a resource is bound to an owner, the binding cannot change:

```javascript
// First insert: set ownership
await Mysql.insert('workers', {
    id: workerId,
    user_id: userId // Set once
});

// Reconnect: update only status/timestamps, never user_id
await Mysql.update('workers',
    { id: workerId },
    { status: 'connected', last_seen_at: new Date() }
);

// Validate: post-upsert check
const actual = await Mysql.findOne('workers', { filter: { id: workerId } });
assert.equal(actual.user_id, expectedUserId, 'Binding mismatch');
```

### 11.3 Error Retry with Exponential Backoff

```javascript
async function retryWithBackoff(fn, maxAttempts = 3) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === maxAttempts - 1) throw err;
            const delay = Math.pow(2, attempt) * 100;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
```

### 11.4 Structured Query Building

Build SELECT, WHERE, JOIN clauses programmatically:

```javascript
class QueryBuilder {
    constructor(table) {
        this.table = table;
        this.columns = ['*'];
        this.filters = {};
        this.limit = 1000;
    }

    select(...cols) {
        this.columns = cols;
        return this;
    }

    where(filter) {
        this.filters = { ...this.filters, ...filter };
        return this;
    }

    build() {
        const cols = this.columns.join(',');
        const whereClause = Object.entries(this.filters)
            .map(([k, v]) => `${k} = ?`)
            .join(' AND ');
        
        return `SELECT ${cols} FROM ${this.table} 
                ${whereClause ? 'WHERE ' + whereClause : ''} 
                LIMIT ${this.limit}`;
    }
}
```

---

## 12. Security Considerations

### 12.1 Worker Honesty Problem

**Known Limitation**: We cannot verify that a worker executes the requested model, streams correct output, or respects user data practices.

**Consequence**: Dishonest workers can:
- Run a different, cheaper model (arbitrage)
- Ignore data privacy commitments
- Return synthetic output

**Current Mitigations**:
- Immutable binding prevents credential hijacking
- API keys encrypted at rest (breach resilience)
- No self-orders prevent self-dealing exploitation
- Rate limiting (future) can detect abuse patterns

**Roadmap Hardening** (not yet implemented):
- Reputation system tied to user complaints and dispute resolution
- Trusted Execution Environment (TEE) attestation
- Challenge-response nonces for execution proof
- Model hash commitments (published up-front)

### 12.2 Ownership Validation Checklist

Before every mutation, verify:

- [ ] Requester's identity resolved via `parseBearerApiKey()`
- [ ] User fetched and identity confirmed (`UsersModel.getByApiKey()`)
- [ ] Target resource's owner matches requester (`worker.user_id === user.id`)
- [ ] Post-upsert re-check of ownership after concurrent updates
- [ ] No self-orders: `requester_id !== worker_owner_id`

### 12.3 API Key Encryption

- **Encryption Algorithm**: AES-256-GCM (authenticated encryption)
- **Secret**: Environment variable `API_KEY_ENCRYPTION_SECRET` (stable, stable)
- **Lookup Hash**: HMAC-SHA256 keyed with encryption secret (indexed column)
- **Breach Scenario**: Stolen ciphertext + hash; attacker cannot derive original key

### 12.4 No Runtime SQL Injection

- **Pattern**: All SQL parameters use prepared statements (placeholders)
- **Sanitization**: `Mysql.#quoteIdentifier()` for table/column names
- **Validation**: Parser helpers validate enum values before SQL

### 12.5 Worker Session Isolation

- Each worker connection is one active socket
- Job events tied to socket instance (not just worker ID)
- Stale socket events ignored (session replacement safety)
- Prevents cross-socket state corruption

---

## 13. Deployment & Configuration

### 13.1 Environment Variables

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `PORT` | API HTTP port | `3000` | `3000` |
| `API_WS_PORT` | WebSocket port (usually same as PORT) | `3000` | `3000` |
| `WORKER_ROUTE` | WebSocket path for workers | `/ws/workers` | `/ws/workers` |
| `MYSQL_ENABLED` | Enable database persistence | `false` | `true` |
| `DB_HOST` | MySQL hostname | `localhost` | `mysql` |
| `DB_USER` | MySQL user | `root` | `root` |
| `DB_PASSWORD` | MySQL password | (required if enabled) | `password` |
| `DB_NAME` | MySQL database | `locallmarket` | `locallmarket` |
| `API_KEY_ENCRYPTION_SECRET` | Stable secret for key encryption | (required if enabled) | `<64-char-hex>` |
| `PLATFORM_FEE_PERCENT` | Settlement fee (0-100) | `0` | `5` |
| `NODE_ENV` | Environment | `development` | `production` |

### 13.2 Docker Compose

**API Service** (`api/compose.yaml`):
```yaml
services:
  api:
    build: .
    ports:
      - "80:3000"
      - "3000:3000"
    environment:
      PORT: "3000"
      API_WS_PORT: "3000"
      MYSQL_ENABLED: "true"
      DB_HOST: "mysql"
      DB_USER: "root"
      DB_PASSWORD: "root"
      DB_NAME: "locallmarket"
      API_KEY_ENCRYPTION_SECRET: "${API_KEY_ENCRYPTION_SECRET}"
    depends_on:
      - mysql

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: "root"
      MYSQL_DATABASE: "locallmarket"
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./schema.sql:/docker-entrypoint-initdb.d/schema.sql
```

**Worker Service** (`worker/compose.dev.yaml`):
```yaml
services:
  worker:
    build: .
    environment:
      API_HOST: "http://api:3000"
      WORKER_ROUTE: "/ws/workers"
      MODEL: "llama2"
      TPS: "20"
      PRICE: "0.001"
```

### 13.3 Schema Migration

Schema updates require explicit SQL migrations:

```bash
# 1. Write migration file
cat > api/migrations/001-add-reputation-column.sql << EOF
ALTER TABLE workers ADD COLUMN reputation DECIMAL(10, 6) DEFAULT 0;
EOF

# 2. Apply manually to development database
mysql locallmarket < api/migrations/001-add-reputation-column.sql

# 3. Update schema.sql with the new schema
# (Don't add runtime ALTER TABLE to app.js)

# 4. Verify and commit
git add api/schema.sql api/migrations/
git commit -m "Migration: add reputation column to workers"
```

---

## 14. Contributing Guidelines

### 14.1 Before Starting

1. Review `.github/memories/` for architecture, patterns, decisions
2. Check `.github/references/api1/` for Express style guidance
3. Inspect related `.github/skills/` for domain expertise (api-development, api-testing, debugging-operations)

### 14.2 Code Changes

1. **Follow Patterns**: Use factories for new routes; models own business logic; helpers stay thin
2. **SQL Confinement**: New queries → add driver method in `mysql.js`, never inline SQL
3. **Error Handling**: Throw `HttpError(code, message)` in models and routes; let errorMiddleware catch
4. **Naming**: Classes in PascalCase (`UsersModel`); functions camelCase (`parseCreateUserBody`)

### 14.3 Testing

1. **Test Framework**: Node.js `node:test` only (no external frameworks)
2. **Module Format**: `.mjs` files with named exports
3. **Coverage**: Add tests for new business logic and routes
4. **Regression Tests**: When fixing bugs, add a deterministic test that verifies the fix

### 14.4 Documentation

1. Update relevant `.github/memories/` files if architecture or patterns change
2. Add JSDoc comments to public functions and exported classes
3. Comment non-obvious business logic in models
4. Link to related code in PR description

### 14.5 Pull Request Checklist

- [ ] Code follows patterns in `.github/references/api1/`
- [ ] All SQL in `api/helpers/mysql.js`
- [ ] Business logic in models (not routes)
- [ ] `HttpError` thrown on validation/business failures
- [ ] Tests added for new logic (unit + integration if applicable)
- [ ] `.github/memories/` updated if patterns or architecture changed
- [ ] No new dependencies added without discussion
- [ ] All tests pass: `npm test`

---

## 15. References & Further Reading

- **Audit Reports**: `.agents/orchestrator/analysis-docs-update/CODEBASE_AUDIT.md` (current state)
- **Test Coverage**: `.agents/orchestrator/analysis-docs-update/TEST_COVERAGE_AUDIT.md` (gap analysis)
- **Architecture Memory**: `.github/memories/architecture.md` (service topology, layer ownership)
- **Patterns Memory**: `.github/memories/patterns.md` (routing, models, SQL, testing)
- **Decisions Memory**: `.github/memories/decisions.md` (immutability, encryption, framework choices)
- **API Reference Profile**: `.github/references/api1/` (Express architecture example)
- **Skills**:
  - `.github/skills/api-development/SKILL.md` (route/model/helper patterns)
  - `.github/skills/api-testing/SKILL.md` (test framework, mocking, coverage)
  - `.github/skills/debugging-operations/SKILL.md` (runtime troubleshooting)
- **README.md**: High-level product overview and deployment guide

---

**Document Version**: 1.0  
**Last Updated**: May 2, 2026  
**Status**: Normative (enforced in code review)
