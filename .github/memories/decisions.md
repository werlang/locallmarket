# Decisions

- The worker package uses Node's built-in `node --test` runner as the active harness for the current ESM stream/WebSocket test suite; obsolete Jest/Babel config was removed.
- Both `api/` and `worker/` use `node:test` with `--test-reporter=spec` and glob patterns in `package.json` scripts (`test`, `test:unit`, `test:integration`). No external test libraries.
- Project skills are stored in `.github/skills/<skill-name>/SKILL.md`. New skills should be placed there rather than relying only on user-level `~/.copilot/skills/`.
