---
name: skill-creator
description: Guide for creating effective skills in .github/skills/. Use when creating a new skill (or updating an existing skill) that extends Agent's capabilities with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill provides guidance for creating effective skills for this repository.

## About Skills

Skills are modular, self-contained packages that extend Agent's capabilities by providing specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains or tasks.

Project skills live in `.github/skills/<skill-name>/SKILL.md`.

## Core Principles

### Concise is Key

The context window is a public good. Only add context Agent doesn't already have. Challenge each piece: "Does Agent really need this explanation?" and "Does this paragraph justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

- **High freedom (text instructions)**: When multiple approaches are valid or decisions depend on context.
- **Medium freedom (pseudocode with parameters)**: When a preferred pattern exists but some variation is acceptable.
- **Low freedom (specific scripts, few parameters)**: When operations are fragile, error-prone, or must follow an exact sequence.

### Anatomy of a Skill

```
.github/skills/<skill-name>/
├── SKILL.md (required)
│   ├── YAML frontmatter: name, description (required)
│   └── Markdown instructions (required)
└── references/       (optional — loaded only when needed)
```

#### SKILL.md Frontmatter

Required fields:

```yaml
---
name: <skill-name>
description: <one-line description used for auto-discovery and invocation>
---
```

The `description` is the primary discovery surface — it must clearly state when the skill triggers. Include exact trigger phrases if the skill should auto-invoke.

#### References (optional)

Documentation intended to be loaded into context as needed. Use for:

- Detailed workflow guides
- API or protocol specifications relevant to the project
- Domain-specific reference material too large for SKILL.md

Keep SKILL.md under ~500 lines. Move detail into `references/` files and link them from SKILL.md.

#### What NOT to include

Do not create:

- `README.md`
- `INSTALLATION_GUIDE.md`
- `CHANGELOG.md`
- Any auxiliary docs about the skill creation process itself

The skill should contain only information needed for an agent to do the job at hand.

## Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata (name + description)** — Always in context.
2. **SKILL.md body** — Loaded when skill triggers.
3. **References** — Loaded only as needed by Agent.

Keep SKILL.md lean. Move detail to `references/` files and reference them explicitly.

## Writing a New Skill

1. Pick a short, lowercase, hyphenated name matching the domain (e.g., `backend-bug-review`).
2. Write a `description` that includes exact trigger phrases users or the agent will use.
3. Write directive, action-oriented instructions — record rules, not narratives.
4. Tie guidance to actual files and conventions in this repository (`api/`, `worker/`, `node:test`).
5. Avoid duplicating rules that already exist in another skill — link instead.
6. Place the file at `.github/skills/<skill-name>/SKILL.md`.

## Updating an Existing Skill

Prefer updating an existing skill over creating a new one when a clear owner exists. See [skill-updater](../skill-updater/SKILL.md) for the update workflow.
