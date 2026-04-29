---
name: document-touched-code
description: Document touched code with JSDoc, method comments, and focused section comments as the default behavior whenever implementing a new feature, refactoring, changing a body of code, writing tests, or improving maintainability. Apply this by default for all code-writing tasks; if the user explicitly requests no comments, respect that.
---

# Document Touched Code

Treat documentation as part of the implementation, not a later cleanup step.

When you add or materially change code, leave the touched area easier to understand than you found it: accurate doc comments on the touched methods/functions and focused local comments where the reasoning would otherwise be expensive to re-derive.

## Project Context

- Both services (`api/` and `worker/`) use Node.js ESM (`import`/`export`).
- Use **JSDoc** for all doc comments throughout the codebase.
- There is no frontend, database, or auth layer — comments about those domains are irrelevant.
- Test files live under `api/test/` and `worker/test/` and use the `node:test` built-in runner.

## Default Standard

1. Add or update doc comments on every touched exported function, class method, constructor, and materially changed private method.
2. Use JSDoc. Annotate `@param`, `@returns`, and `@throws` where the types or semantics are not obvious from names alone.
3. Add short section comments near non-trivial logic you added or materially changed.
4. Keep comments focused on intent, assumptions, invariants, ordering, edge cases, and decision points.
5. Rewrite or remove stale comments when behavior changes.
6. Do not leave touched code less documented than the surrounding codebase standard.

## Workflow

1. Identify every method, function, or class member you touched.
2. Update doc comments so the signature, parameter meaning, return value, side effects, and important invariants still match reality.
3. Scan the changed logic for the places where a future maintainer would have to stop and mentally simulate the code.
4. Add one focused comment at those points, close to the code it explains.
5. Re-read the result and delete any comment that only repeats the next line instead of explaining why it exists.

## Where Comments Usually Matter

- Reconnect back-off logic, heartbeat timing, and session lifecycle transitions
- SSE flush behavior, backpressure, and connection teardown ordering
- Queue capacity guards, job cancellation races, and dequeue edge cases
- LLM stream chunk assembly, partial-chunk handling, and stream abort propagation
- Error wrapping that intentionally changes the error shape before re-throwing
- Places where the implementation intentionally does something non-obvious

## Comment Quality Rules

Do:

- Explain why the block exists or why the order matters.
- Call out assumptions, constraints, and edge-case handling.
- Use section comments to break long methods into meaningful phases.
- Keep wording specific enough that future edits can validate whether the comment is still true.

Do not:

- Narrate obvious line-by-line behavior.
- Add boilerplate doc comments that merely rename parameters.
- Leave outdated comments in place after changing behavior.
- Add comments everywhere indiscriminately; add them where comprehension would otherwise slow down.

## Quick Heuristics

- If a method signature changed, its JSDoc probably needs an update.
- If a block took more than a quick glance to understand, it probably deserves a short local comment.
- If the code is already obvious from names and structure, prefer no comment.
- If a comment would be valid in almost any Node.js project, make it more specific to this codebase.
