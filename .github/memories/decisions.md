# Decisions

- The worker package uses Node's built-in `node --test` runner as the active harness for the current ESM stream/WebSocket test suite; obsolete Jest/Babel config was removed.
- The API package also uses Node's built-in `node --test` runner (`npm test`) for helper/model/driver coverage, including SQL-confinement checks.
- `api1` is the selected reference profile for this project's Express organization: thin `app.js` composition root, named `router` exports in `routes/`, `sendSuccess`/`sendCreated` envelope helpers, `HttpError` + `errorMiddleware` for errors, owner identity from `x-user-external-id`. See `.github/references/api1/` for the canonical example.
- Before implementing any new API feature, consult `.github/references/` (especially `api1`) and the `skills1` skill files for established patterns. Do not inline behavior that the reference profile places in helpers, models, or drivers.
- Both `api/` and `worker/` use `node:test` with `--test-reporter=spec` and glob patterns in `package.json` scripts (`test`, `test:unit`, `test:integration`). No external test libraries.
- Project skills are stored in `.github/skills/<skill-name>/SKILL.md`. New skills should be placed there rather than relying only on user-level `~/.copilot/skills/`.
