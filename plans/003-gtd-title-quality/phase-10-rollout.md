# Phase 10. Migrate rules and verify the shipped surface

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Make the new contract reviewable, adopt tested rules deliberately, and verify the live plugin.

## Changes

- Update `plugins/gtd-sidebar/README.md` with the winning context, format, model/effort, and migration behavior.
- Migrate this repository's `.agents/GTD_TITLE.md` to `.agents/GTD_NAMING.md`, preserving user rules and applying only evaluated improvements.
- Adopt each other repository's reviewed setup draft as a separate scoped change. Do not overwrite those repositories during setup or bundle their commits with bb-plugins.

Explain that repository setup is explicit and one-time. Title inference remains prompt-only. State the actual measured limits and the exact ☑️ eligibility rule. Keep provenance and large maps out of recurring prompts.

## Data structures

The only persistent configuration is the canonical naming-rule document. Local evaluation manifests retain the baseline revision and winning policy for reproduction and rollback.

## Verification

Static: run the required repository lint, format, typecheck, and test gates. Validate documentation examples against the accepted formatter and rule loader. Preserve unrelated changes.

Runtime: complete the isolated `verify-bb-plugins` workflow on GTD cards and slim rows, including visible truncation, accessible labels, and search. Then inspect `bb plugin source gtd-sidebar`, ensure it resolves to this local checkout, and reload `gtd-sidebar` against the live instance. Verify a controlled rename and the plugin's running state. Do not reload agent-proxy.

If the live check fails, restore only this task's last passing naming implementation and reload it. Retain the evidence and describe the failure. Do not batch rewrite historical thread titles.

Exit: a concise comparison of baseline and winner, cost and latency, representative title pairs, known limitations, setup cost, source/reload status, and local commit status. No push or PR without the user's instruction.
