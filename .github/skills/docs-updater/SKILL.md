---
name: docs-updater
description: Update README.md, .github/memories/, and .github/skills/ after any new feature, refactor, or code behavior change in api/ or worker/. Auto-invoke when code changes are finalized. Trigger phrases: "update docs", "update memories", "keep docs updated", "docs are stale", "update skills".
applyTo: "api/**,worker/**"
---

# docs-updater

After any feature addition, refactor, route change, helper change, or new test pattern in `api/` or `worker/`, sweep and update all documentation artifacts.

## 1. README.md Sweep

File: `README.md`

- **Services table** — verify ports and responsibility descriptions match `api/app.js` and `worker/app.js`.
- **Repository Layout** — verify it matches the actual file tree (`api/`, `worker/`, their subdirectories, and test files).
- **API Contract** — verify request/response examples match current route handlers.
- **Running Locally** — verify compose commands match `api/compose.yaml` and `worker/compose.dev.yaml`.
- **Running Tests** — verify `npm test`, `npm run test:unit`, `npm run test:integration` commands are accurate for both services.
- Remove any stale sections; add new sections for new features.

## 2. Memories Update

Update the relevant file(s) under `.github/memories/`:

- **`architecture.md`** — if new services, routes, or protocols were added or changed.
- **`decisions.md`** — record the key technical decision made (why this approach, what was rejected).
- **`patterns.md`** — record any reusable pattern introduced (new error handling, queue usage, SSE pattern, test helper).
- **`bugs.md`** — record any bug class discovered or fixed as a known category to watch in future reviews.

Only update files where the change is material. One-line additions are fine.

## 3. Skills Staleness Check

Review each skill and update if the change affects its guidance:

- `.github/skills/api-development/SKILL.md` — route contracts, middleware order, SSE/WebSocket behavior.
- `.github/skills/api-testing/SKILL.md` — new test patterns, newly covered modules, helper usage.
- `.github/skills/docker-deployment/SKILL.md` — compose file changes, new env vars, port changes.
- `.github/skills/debugging-operations/SKILL.md` — new failure points, new diagnostic commands.
- `.github/skills/test-first-delivery/SKILL.md` — test runner command changes, new coverage requirements.

## 4. Consistency Check

After updating, confirm:
- No contradictory claims exist across README, memories, and skills (e.g., a port listed differently in two places).
- All paths referenced in docs exist in the actual file tree.

## 5. Output Report

After completing the sweep, report:
- **Files updated** — each file with a one-line reason.
- **Memory entries added or modified** — file and entry summary.
- **Skills updated** — skill name and what changed.
- **Remaining gaps** — anything that needs manual attention (e.g., browser-only validation, env var secrets).
