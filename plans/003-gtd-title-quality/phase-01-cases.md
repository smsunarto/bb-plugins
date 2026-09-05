# Phase 1. Freeze replay cases

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Make title quality measurable without guessing what the generator knew.

## Changes

- Add `scripts/gtd-title-eval/cases.ts` for event-time snapshot extraction and the development/holdout manifest.
- Add `scripts/gtd-title-eval/cases.test.ts` for provenance, cutoff, and partition behavior.
- Add `scripts/gtd-title-eval/fixtures.json` containing synthetic regression examples and labels only.

Keep raw historical cases in task storage. Reconstruct the previous local review from source events when possible. Do not call every applied title a GTD generation. Freeze the dataset before comparing prompts.

## Data structures

`NamingCase` identifies a thread checkpoint, available prompt facts, reference facts, provenance, and split. Input facts and grader-only labels are separate fields that the prompt builder cannot confuse.

## Verification

Static: focused extraction tests and TypeScript checks. Prove cutoff exclusion, whole-thread split isolation, and deduplication.

Runtime: export a bounded real sample read-only, then inspect one continuation and one phase-change case against their source events. Report the actual number of eligible cases and exclusions. No title writes or model calls.

Exit: hashed manifest and sealed holdout with explicit reconstruction limits.
