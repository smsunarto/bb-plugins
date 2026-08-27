# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: each plugin and each framework package is its own context.

## Before exploring, read these

* **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.

If `CONTEXT-MAP.md` does not exist, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms actually get resolved.

## File structure

```
/
├── CONTEXT-MAP.md                     ← points at each context below
├── packages/
│   └── bb-kit-core/
│       └── CONTEXT.md
└── plugins/
    └── <id>/
        └── CONTEXT.md
```

## Relation to `AGENTS.md`

Root `AGENTS.md` holds the workflow and the workspace invariants. Nested `AGENTS.md` files (for example `plugins/dotfiles/AGENTS.md`) take precedence within their scope. Domain docs are separate: `CONTEXT.md` holds the ubiquitous language for a context. Do not duplicate invariants from `AGENTS.md` into a `CONTEXT.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).
