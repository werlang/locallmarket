---
name: refactor-feature-additions
description: Deliver refactors and feature additions to the API or Worker services with the full quality contract: documentation, tests, and validation. Use when changing application behavior, extracting logic, renaming, or adding new capabilities to either service.
---

# Refactor & Feature Delivery

## When to Use This Skill

Use this skill for any task that:

- Refactors existing code (structure, naming, extraction, simplification, cleanup)
- Adds a new feature
- Changes existing feature behavior
- Touches API or Worker business logic

## Default Quality Contract

Unless the user explicitly says otherwise:

1. Implement the feature/refactor change.
2. Add or update JSDoc for any exported function, class, or method you touch.
3. Leave focused comments near non-trivial logic you added or materially changed so intent and edge-case handling are obvious in-place.
4. Add or update tests for the modified behavior.
5. Run the relevant test command(s) for the affected service.
6. Fix failures and re-run until tests pass.
7. Report what changed and how it was validated.

Do not stop after code changes only when testable behavior was modified.

## Workflow

### Step 1: Define Behavior Delta

- List exactly what behavior changed.
- Keep unrelated behavior unchanged.
- Identify the narrowest test scope that proves the delta.

### Step 2: Implement with Minimal Scope

- Prefer root-cause refactors over superficial patches.
- Keep public APIs stable unless the change requires breaking them.
- Preserve existing style: ESM, Node.js 22+, `node:test`, no transpilation.
- Treat documentation as part of the implementation: update JSDoc on touched methods/functions and explain complex decision points close to the changed code.

### Step 3: Update Tests for the Delta

- Add/adjust tests in the appropriate service test directory (`api/test/` or `worker/test/`).
- Use `node:test` + `node:assert/strict` — no Jest, no Mocha.
- Use fake sockets and mock fetch for isolation (see the `api-testing` skill for patterns).
- Avoid broad rewrites of unrelated tests.

### Step 4: Run and Iterate Until Green

```bash
# API service
cd api && npm run test:unit
cd api && npm run test:integration

# Worker service
cd worker && npm run test:unit
cd worker && npm run test:integration
```

Fix code or tests and rerun until all pass.

### Step 5: Fallback When Automation Is Missing

- If the changed behavior touches WebSocket or SSE flows that are hard to cover with unit tests, provide a manual validation checklist using the curl/wscat patterns from the `debugging-operations` skill.
- Explicitly note any coverage gaps in the task handoff.

## Validation Checklist

- [ ] Feature/refactor behavior works as requested.
- [ ] Touched exported functions/classes/methods have accurate JSDoc.
- [ ] Complex changed logic has local comments explaining intent and non-obvious constraints.
- [ ] Tests exist for the modified behavior (or an explicit gap note is provided).
- [ ] Test command output is green for the executed scope.
- [ ] No unrelated regressions introduced.

## Done Criteria

A task is complete only when:

- Code changes are in place.
- Touched code has been documented with JSDoc and focused explanatory comments.
- Relevant tests were added or updated.
- Tests were run and pass for the validated scope.
- Any unavoidable coverage gaps are explicitly documented.
