---
name: test-first-delivery
description: Deliver behavior changes, bug fixes, refactors, and feature work in the api/ and worker/ services with tests or explicit validation. Use when changing application behavior, updating existing tests, reviewing missing coverage, or documenting testing gaps in either service.
---

# Test-First Delivery

Use this skill whenever a task changes behavior.

## Default Quality Contract

- Do not treat a behavior-changing task as done with code changes alone.
- If the touched area already has automated coverage, update that coverage and run it.
- Prefer the narrowest honest validation path that can prove the changed contract.
- Add success cases plus meaningful edge cases, not only happy-path assertions.
- Prefer service-local tests for the changed area instead of broad harness changes.
- If automation is missing, decide whether a small local test addition is justified or whether explicit manual validation is the honest path.
- Finish by stating what was validated, what was not, and why.

## Repository Reality

This repository contains two Node.js ESM services:

| Service | Directory | Purpose |
|---------|-----------|---------|
| API | `api/` | Express 4 HTTP server: `GET /ready`, `POST /stream` (SSE), WebSocket server for workers |
| Worker | `worker/` | Outbound WebSocket client to API, LLM model runner, job queue |

**Test runner**: Node.js built-in `node:test` — NOT Jest.
**Test file convention**: `.mjs` extension under `test/unit/` and `test/integration/` within each service.

## Validation Commands

### Worker service

```sh
# Unit tests only
cd worker && npm run test:unit

# Integration tests only (requires API reachable)
cd worker && npm run test:integration

# All worker tests
cd worker && npm test
```

### API service

```sh
# Unit tests only
cd api && npm run test:unit

# Integration tests only
cd api && npm run test:integration

# All API tests
cd api && npm test
```

## Test Design

- Prefer pure assertions for deterministic helpers, parsing, queue logic, error mapping, and routing logic.
- Prefer server/route tests for SSE output, WebSocket message contracts, middleware behavior, and status-code mapping.
- Prefer integration tests when the contract spans both the HTTP layer and real TCP connections (e.g., SSE relay end-to-end, worker reconnect).
- Avoid large snapshot-heavy tests when smaller semantic assertions can prove the contract.
- There is no frontend, browser, or database layer — do not add Playwright, jsdom, or DB fixture setup.

## Workflow

1. Identify the owner of the behavior change: `api/` service, `worker/` service, or shared helpers.
2. Check whether the touched area already has automated tests or whether a small local harness should be added.
3. Add or update the narrowest honest tests alongside the production change.
4. Run the relevant commands above for the affected service.
5. Fix failures and rerun the validated scope until it is green.
6. Finish with explicit reporting:
   - automated tests or commands run
   - manual checks performed (if any)
   - remaining gaps or environment limits

## Done Criteria

A behavior-changing task is complete only when:

- the implementation is in place,
- automated tests were updated and run when they existed or were intentionally bootstrapped,
- changed behavior has meaningful success and edge-case coverage where deterministic automation is practical,
- and the final report plainly calls out remaining gaps.

There is no browser or frontend validation step for this project.
