# Decisions

## API HTTP Surface Owned by API Service

**Decision**: All client-facing REST + streaming endpoints owned by API service; worker services have no inbound HTTP/WebSocket server.

**Rationale**:
- Centralized authentication and authorization boundary
- Single point for rate limiting, logging, monitoring
- Simplifies credential validation and ownership enforcement
- Workers are queue consumers, not service providers to external clients
- Easier to upgrade API surface without worker service changes

## Worker Binding is Immutable

**Decision**: `workers.user_id` set once on initial insert, never updated on reconnect.

**Rationale**:
- **Security**: Prevents hijacking attacks where concurrent registrations by different API keys could reassign worker ownership
- **Coherence**: Worker offering is bound to owner; migration requires explicit re-registration
- **Post-upsert Safety**: Ownership recheck after upsert catches race conditions
- **Implementation**: `WorkersModel.bindConnectedWorker()` only updates status/timestamp, never owner

## API Keys Encrypted at Rest

**Decision**: User API keys stored as encrypted ciphertext (AES-256-GCM) + HMAC-SHA256 lookup hash.

**Rationale**:
- **Breach Resilience**: Encrypted keys unreadable if DB compromised; original key irretrievable
- **Fast Lookup**: HMAC hash enables indexed bearer token resolution without decryption loop
- **Per-User Secret**: Encryption secret (`API_KEY_ENCRYPTION_SECRET`) stable across restarts; tied to database snapshot
- **Pattern**: From `api1` reference profile; industry-standard secure-at-rest storage

## Orders Created on Dispatch (Not Marketplace-Style Standing Orders)

**Decision**: Orders are execution records created when job dispatched; no standing order market model.

**Rationale**:
- **Simplicity**: Avoids complex multi-party order matching and order cancellation logic
- **Immediate Accountability**: Worker and consumer bound at dispatch; no stale standing orders
- **Price Certainty**: Consumer sees exact price at request time; no surprise price changes
- **Settlement Clarity**: Order-to-execution 1:1 mapping eliminates partial fills and complex accounting
- **Future**: Standing market model can be added as new API variant without breaking dispatch model

## No Built-In Worker Execution Verification

**Decision**: Cannot verify worker executes correct model, output authenticity, or data practices.

**Rationale**:
- **Technical Gap**: Workers are external black boxes; no proof-of-execution mechanisms in place
- **Current Mitigation**: Reputation system (24h uptime + request count) provides weak trust signal
- **Roadmap**: Future hardening via TEE, model hashing, challenge-response nonces, dispute system
- **Honest**: Documentation explicitly marks this as a known limitation

## MySQL Optional (MYSQL_ENABLED Flag)

**Decision**: Database persistence controlled by `MYSQL_ENABLED=true` environment variable.

**Rationale**:
- **Dev/Test Flexibility**: Unit tests and ephemeral deployments run without database dependency
- **In-Memory Mode**: Fallback to in-memory state during development
- **Production Requirement**: Binary decision: either MySQL-backed persistence or ephemeral state
- **No Hybrid Mode**: Must be all-or-nothing to avoid partial state consistency issues

## Entity Business Logic Owned by Models

**Decision**: All entity business logic (validation, state transitions, policy) owned by model layer.

**Rationale**:
- **Separation of Concerns**: Models encapsulate domain rules; routes handle HTTP only
- **Reusability**: Business logic not coupled to HTTP framework or helper utilities
- **Testability**: Models tested independently of Express/routing
- **Maintenance**: Single authoritative place for entity rules
- **Anti-Pattern Enforcement**: Routers, helpers, middleware, driver must never implement business logic

## Test Framework: Node.js Built-in `node:test`

**Decision**: Use Node.js `node --test` runner; no external test libraries (Jest, Mocha, etc.).

**Rationale**:
- **Zero Dependencies**: Reduces bundle, CI/CD complexity, security surface
- **Modern ESM**: Eliminates Babel transpilation and Jest config complexity
- **Native**: Part of Node.js runtime; no version coordination required
- **CLI**: Glob patterns in `package.json` scripts enable `npm test`, `npm run test:unit`, etc.
- **Reporter**: `--test-reporter=spec` provides readable output

## Reference Profile: `api1`

**Decision**: All new API features modeled after `.github/references/api1/` Express architecture.

**Rationale**:
- **Established Pattern**: Proven composition, routing, error handling, response envelope style
- **Consistency**: Prevents ad-hoc framework choices across different services
- **Onboarding**: New developers have a canonical example to follow
- **Code Review**: Deviation from `api1` requires explicit decision and documentation

## Settlement: Completion-Time Billing

**Decision**: Total cost computed from token usage and model price-per-million at job completion.

**Rationale**:
- **Accuracy**: Cost unknown until job finishes (token output depends on model behavior)
- **Accountability**: Worker provides final token count; no pre-billing estimates
- **Transparency**: Consumer sees exact charge; no surprise overages
- **Split Logic**: Cost split by `PLATFORM_FEE_PERCENT` between platform and worker owner

## Schema Migrations: Explicit, Not Auto-DDL

**Decision**: Schema creation/evolution handled by explicit SQL scripts run outside runtime.

**Rationale**:
- **Control**: Production DB changes require explicit review and approval
- **Safety**: No auto-schema-patching on app startup (risky for data integrity)
- **Auditability**: Migration history trackable in version control
- **Rollback**: Manual migrations easier to reverse than auto-DDL
