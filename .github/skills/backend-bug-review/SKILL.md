---
name: backend-bug-review
description: Deeply review api/ and worker/ service code for WebSocket session bugs, SSE relay defects, queue dispatch errors, job lifecycle bugs, and LLM stream processing failures. Use when auditing server-side code for real defects or pairing bug-finding with deterministic regression tests.
---

# Backend Bug Review

Use this skill for skeptical backend review work when the goal is to find real defects, prove them, and lock them down with regression coverage.

## Required Pairing

Always pair this skill with [../test-first-delivery/SKILL.md](../test-first-delivery/SKILL.md).

This skill finds likely defects.
`test-first-delivery` supplies the contract for updating tests, choosing validation, and rerunning the relevant suite until it is green.

## Focus Areas

Prioritize defects that can change behavior, data, or runtime stability in these two services:

**API service (`api/`)**
- SSE relay correctness: headers, flush, connection teardown
- WebSocket server session lifecycle: open, message dispatch, close, error
- Stream router: job routing to correct worker, backpressure, timeout handling
- Queue: job enqueue/dequeue ordering, capacity limits, job cancellation

**Worker service (`worker/`)**
- WebSocket client reconnect logic: back-off, duplicate subscriptions, stale session
- Job lifecycle: received → processing → complete/failed state transitions
- Worker-to-API jobId correlation: late events delivered to wrong or closed session
- LLM stream processing: partial chunk handling, stream abort, error propagation
- api-client: retry vs. give-up logic, request timeout, error wrapping

Do not spend the review on style-only suggestions or refactors without a concrete bug risk.

## Review Workflow

1. Scope the backend surface under review: handlers, routes, helpers, model, and nearby tests.
2. Read the production code first and identify the highest-risk boundaries and state transitions.
3. Look for contract mismatches between code, error handlers, and the WebSocket/SSE protocol.
4. For each likely bug, decide whether it is already covered by a deterministic test in the nearest existing suite.
5. If not covered, add or update a focused regression test using `node:test` in the relevant `.mjs` file.
6. Run the narrowest trustworthy command for the affected service scope.
7. If a regression fails, fix the production root cause, not only the symptom.
8. Rerun the affected validation scope until it is green.
9. Report findings ordered by severity, then list remaining integration-only gaps.

## Bug Heuristics

Prefer investigating these patterns early:

- Reconnect logic that re-registers listeners without removing old ones (memory leak / duplicate events)
- Job cancellation race: API removes job from queue while worker is mid-stream
- Worker-jobId mismatch: late stream chunk arrives after the client SSE session closed
- Async flows that can partly succeed and leave job state inconsistent
- Queue dequeue that does not handle the case where the next consumer disconnects before acknowledging
- LLM stream abort path that does not propagate cancellation back to the API
- Error wrapping in api-client that hides the HTTP status code from the caller
- Startup wiring that assumes optional environment variables are present without fallback

## Validation Commands

```sh
# Worker unit tests
cd worker && npm run test:unit

# Worker integration tests (requires API service reachable)
cd worker && npm run test:integration

# API unit tests
cd api && npm run test:unit

# API integration tests
cd api && npm run test:integration
```

## Output Expectations

When the user asked for a review, findings come first.

Each finding should include:

- severity
- the affected file, module, or behavior (`api/` or `worker/`)
- why it is a real bug or likely runtime defect
- whether a regression test exists, was added, or is still missing

Keep summaries brief. The value of this skill is in precise bug finding plus executable regression coverage.
