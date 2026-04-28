# Audit Project Context Against Repository Reality

Audit `.github` documentation and customization files to confirm they describe the current repository accurately.

## Objective

Ensure instructions, skills, and prompts remain synchronized with implementation status and avoid stale cross-project residue.

## Scope

- `.github/copilot-instructions.md`
- `.github/skills/README.md`
- `.github/skills/**/SKILL.md`
- `.github/skills/**/references/*.md`
- `.github/prompts/*.md`

## Audit Method

1. Read in-scope docs first.
2. Verify claims against files that exist in repository root and `.agents/orchestrator/...`.
3. Remove or rewrite any statement that assumes non-existent runtime pieces.
4. Re-check consistency of paths, commands, and task workflow language.

## Must-Check Items

- Documented commands can actually be executed here.
- Mentioned files/folders exist.
- No inherited references to unrelated project domains or services.
- MVP status is represented honestly (prototype vs implemented runtime).

## Output Format

```markdown
## Context Audit Summary

### Files Updated
- .github/...

### Accuracy Fixes
- Fixed: <claim> -> <verified reality>

### Remaining Gaps
- <code or setup gap found during audit>
```