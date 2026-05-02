# Known Issues and Mitigations

## Worker Session Edge Cases

**Issue**: Late chunk/completion/failure events from disconnected socket can corrupt active worker state.

**Scenario**:
- Worker job-A executing on socket-1
- Socket-1 closes; worker reconnects on socket-2
- Late chunk event from socket-1 arrives after socket-2 is active
- If chunk handler doesn't gate on active socket ID, state corruption occurs

**Mitigation**: 
- Runtime socket events must verify event's socket matches active socket session
- Discard events from replaced/disconnected sockets
- Implement active job tracking per socket

**Test Gap**: `api/test/integration/` missing; full HTTP→WebSocket reconnect cycle untested.

**Priority**: HIGH — affects job reliability in production

## Order Settlement Concurrency

**Issue**: Simultaneous job-complete + cancellation, or insufficient credits during settlement.

**Scenarios**:
- Consumer issues cancellation while worker sends completion
- Concurrent settlements deplete consumer credits; second order fails to settle
- Stale job metadata during settlement causes debit mismatch

**Mitigation**:
- Settlement transactions must verify requester identity matches order owner before credit mutations
- Atomic debit/credit operations using MySQL transactions
- Reject settlement if consumer credits insufficient
- Test coverage for concurrent settlement attempts currently missing

**Test Gap**: `api/test/models/orders.test.mjs` missing concurrent settlement scenario.

**Priority**: MEDIUM — affects financial accuracy

## Worker Honesty: Cannot Verify Execution

**Issue**: No way to verify:
- Worker executed correct model (could run different model)
- Output is authentic (could be synthesized/faked)
- Worker not injecting malicious data
- Worker not collecting user data

**Current Mitigation**: Reputation system (24h uptime % + 24h request count) provides weak trust signal only.

**Roadmap**:
- Model execution proof-of-work (nonce challenge, model hash verification)
- TEE (Trusted Execution Environment) attestation
- Consumer dispute/feedback system
- Worker suspension on reputation collapse

**Impact**: Worker honesty is inherent limitation of decentralized model; not immediately fixable.

**Priority**: LOW — architectural limitation; future enhancement

## Reputation System Weakness

**Issue**: Current reputation (24h uptime % + 24h request count ÷ 2) insufficient for trust.

**Limitations**:
- No validation of output quality
- No consumer complaint tracking
- No model-specific reputation (worker could switch models and deceive)
- 24h window too short for behavioral patterns
- No weight for critical failures (crashes, disconnects)

**Current Behavior**: Reputation computed on connect/disconnect/completion and updated in `workers` table.

**Roadmap**: Multi-factor scoring including complaint-to-completion ratio, model consistency, uptime streaks.

**Priority**: MEDIUM — needed for consumer confidence

## Missing Integration Tests

**Issue**: Full HTTP→WebSocket→HTTP dispatch cycle untested.

**Coverage Gap**:
- `api/test/integration/` folder empty
- No tests for:
  - Consumer makes request → API selects worker → worker executes → chunks relay → settlement
  - Worker reconnect with stale socket cleanup
  - Parallel worker registrations (race condition)
  - Order cancellation during execution
  - Worker failure and credit refund

**Current State**: Unit tests cover individual components; integration tests verify wiring.

**Mitigation**: Create `api/test/integration/` with full-cycle scenarios using PORT='0'/API_WS_PORT='0' for OS-assigned ports.

**Priority**: HIGH — integration tests catch real-world bugs

## Ownership Validation Gap

**Issue**: Worker matching must verify offer owner ≠ requester; stale rows can spoofed selection.

**Mitigation**: `OrdersModel.findFirstAvailableOfferByModel()` must post-filter for offer/worker ownership coherence before trusting price metadata.

**Test Gap**: `routes/openai.test.mjs` missing self-order rejection test.

**Priority**: MEDIUM — prevents order creation between same user's offers
