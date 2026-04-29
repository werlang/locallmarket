---
name: audit-project-context
description: "Audit, verify, update, or clean docs, prompts, skills, agents, instructions, README files, and other markdown/MD files against the current project codebase. Use when documentation or agent context may be stale, inaccurate, inconsistent, or aspirational and must be aligned with the real implementation."
argument-hint: "Project path or audit scope"
user-invocable: true
---

# Audit Project Context

Use this skill to audit the current project's documentation and agent customization files against the actual implementation, then rewrite inaccurate sections so the context stays trustworthy.

## Covers

- `.github/**`
- `.agents/**`
- `README.md`
- `api/` — Express 4 stream router, SSE relay, WebSocket server
- `worker/` — WebSocket client, LLM model runner, job queue

## Workflow

1. Read the in-scope docs and customization files first to understand the current documented state.
2. Research the actual implementation: runtime, services, routes, entities/models, config, env vars, scripts, infrastructure, tests, and deployment expectations.
3. Compare docs to code and record discrepancies.
4. Update inaccurate, stale, or incomplete files. Remove aspirational claims that are not enforced by code or tooling.
5. Sweep for terminology drift, broken links, missing files, and contradictory claims across docs.
6. Return a structured result listing files updated, discrepancies fixed, and remaining issues.

## Rules

- Code and configuration are the source of truth.
- Do not preserve "should", "must", or "we have" language unless the repository actually enforces it.
- Keep accurate structure when useful, but rewrite incorrect technical details.
- If a doc references tooling, agents, or files that do not exist, fix or remove the reference.

## Required Checks

- Routes, commands, env vars, ports, and file paths are real.
- Skill descriptions and examples match actual workflows.
- Prompts and agents point to files and conventions that exist.
- README/setup steps are executable for the current project.
- Cross-file terminology is consistent for the same concepts.
- Test runner referenced is `node:test` (NOT Jest).
- Docker Compose files referenced: `api/compose.yaml` for API, `worker/compose.dev.yaml` for worker dev.

## Output

Return:

- files updated
- key discrepancies fixed, removed, or added
- remaining implementation issues discovered during the audit
- confidence notes for terminology and consistency sweeps
