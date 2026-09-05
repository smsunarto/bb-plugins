# Phase 5. Define compact repository rules

[Plan overview](overview.md) · [Heuristics](heuristics.md)

## Goal

Give the generator repository-specific scope vocabulary without repeated exploration.

## Changes

- Add a bounded rule normalizer in `plugins/gtd-sidebar/lib/naming-rules.ts`.
- Add `plugins/gtd-sidebar/test/naming-rules.test.ts`.
- Define the setup-output contract in `scripts/gtd-title-eval/setup-prompt.md`.

Use human-readable `.agents/GTD_NAMING.md` with canonical scopes, deliberate aliases, ownership cues, and an unscoped fallback. Keep the existing plain-text instruction approach unless a structured section is needed for deterministic selection. Avoid a new configuration language.

Target at most 200 injected rule tokens, measured with a pinned tokenizer validated against the chosen model's input usage. Until that validation exists, describe 200 as a target rather than an enforced token cap. Enforce a deterministic 768-byte UTF-8 bound by dropping whole optional rules, never slicing one. Rules consume the total recurring input budget. Prefer a few stable rules over a whole repository inventory. If selection of relevant mappings is necessary, do it deterministically before inference. Do not truncate halfway through a scope rule or let repository text override the global no-repository/ship-evidence contract.

## Data structures

`NamingRules` is bounded instruction text plus explicit canonical labels/aliases only if deterministic matching needs them. Empty or unreadable configuration yields conservative unscoped behavior.

## Verification

Static: missing, over-budget, ambiguous, conflicting, and valid multi-scope examples.

Runtime: replay bb-plugins and dotfiles cases with and without the exact rule text. Show what was injected and how many tokens it consumed. Count no benefit from scope facts unavailable in the prompt.

Exit: compact documented rules and a measured scope-accuracy candidate.
