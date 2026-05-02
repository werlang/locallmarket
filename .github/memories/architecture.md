# Architecture

## Service Topology

**Three-tier distributed system**:
- **API Service** (port 3000): HTTP REST surface + WebSocket server for inbound worker connections
- **Worker Service**: Outbound WebSocket client to API; executes LLM jobs; no inbound server
- **MySQL** (optional): Persistent user/worker/order records; enabled via `MYSQL_ENABLED=true`

## Request Flow

```
Consumer:           POST /v1/chat/completions
                            ↓
API (routes/openai.js):     Resolve user identity from Bearer token
                            Retrieve max_price, min_tps constraints
                            ↓
OrdersModel:                Find first available worker (price ASC, tps DESC)
                            Create order record: { requester_id, worker_id, status: 'running' }
                            ↓
StreamRouter:               Enqueue job to worker via WebSocket
                            ↓
Worker (WebSocket):         Receive job dispatch
                            Execute LLM model
                            Stream chunks back to API
                            Send job-complete with token usage
                            ↓
API (StreamRouter):         Relay chunks as SSE to consumer
                            On completion: settle order (debit consumer, credit worker owner)
                            Mark order: status='completed'
```

## Layer Ownership

| Layer | Responsibility |
|-------|----------------|
| **Routes** | Parse HTTP request, call model, send response (thin orchestration only) |
| **Models** | Entity business logic, validation, state transitions, persistence via driver |
| **Helpers** | Cross-entity domain logic (auth parsing, stream relay, error handling) |
| **Driver** | Generic SQL methods (find, insert, update, upsert); never business logic |
| **Middleware** | Express error handler (terminal 5xx catcher) |

**Key Rule**: Business logic lives exclusively in models; routers/helpers/middleware/driver must not implement entity logic.

## Worker Binding and Persistence

- Workers bind to users via API key validation on `/ws/workers` WebSocket handshake
- `WorkersModel.bindConnectedWorker()` validates API key → resolves user → upserts worker record
- **Immutability Guarantee**: `user_id` set once on insert, never updated on reconnect
  - Prevents hijacking via concurrent registration by different API keys
  - Post-upsert ownership recheck rejects mismatched persisted binding
- Indexes on `(user_id)`, `(status)`, `(user_id, status)` enable efficient matching queries
- No self-orders: `requester_id ≠ worker_owner_id`

## Order and Settlement Flow

- OpenAI requests auto-select worker → create internal order → dispatch job → relay chunks
- Completion triggers settlement: debit consumer credits, credit worker owner (minus platform fee)
- Failure compensation: order marked failed, consumer credits restored
- Observed TPS updated on completion from token usage / elapsed execution time

## Consumer Matching Constraints

- Users set optional `max_price` and `min_tps` on account
- Worker matching enforces: `price <= max_price AND tps >= min_tps`
- Selection order: `price ASC, tps DESC` (cheapest first, TPS tie-breaker)

## Deployment Topology

- `api/compose.yaml`: API on port 80:3000
- `worker/compose.dev.yaml`: Workers on `llm` bridge network (no external ports)
- Each worker replica has mounted `/app/node_modules` to avoid shared dependency races

## App Composition

- `api/app.js` exports: `app` (Express instance), `server` (HTTP server), `streamRouter`
- Routes: mixed export styles (direct router vs factory functions — see patterns.md)
- Constructs: `WSServer` + `StreamRouter`, wires `ordersModel.streamRouter`, `/ready` health check
- `server` export required by integration tests for cleanup via `server.close()`
