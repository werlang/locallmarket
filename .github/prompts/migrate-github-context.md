# Migrate .github Context Into This Repository

Migrate copied `.github/` context from another project into this repository and rewrite it so every technical claim matches files that exist here.

## Goal

Keep useful process structure from source projects while removing stale architecture, commands, and path claims.

## Required Inputs

- Source `.github` paths used for migration
- Target repository root (`orchestrator`)
- Current canonical task plan (if migration is part of a tracked task)

## Required Files To Audit In Target

1. `.github/copilot-instructions.md`
2. `.github/skills/README.md`
3. `.github/skills/*/SKILL.md`
4. `.github/skills/*/references/*.md`
5. `.github/prompts/*.md`

## Workflow

1. Inventory current implementation files in this repository first.
2. Read migrated docs and classify each claim as accurate, partial, stale, or not applicable.
3. Rewrite only what is needed so docs match current reality.
4. Sweep for stale terms from source projects.
5. Report updated files and remaining non-documentation gaps.

## Rules

- Code and committed files are the source of truth.
- Do not keep aspirational claims written as existing implementation.
- Prefer deleting misleading claims over leaving ambiguous text.
- Keep the resulting `.github` set minimal and practical for the current MVP phase.

## Output Format

```markdown
## Migration Summary

### Files Updated
- .github/...

### Stale Claims Removed
- <old claim> -> <new repository-accurate claim>

### Remaining Gaps
- <code or implementation gap discovered during migration>
```