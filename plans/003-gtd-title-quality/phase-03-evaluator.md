# Phase 3. Build the dry-run evaluator

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Run paired experiments without renaming live threads.

## Changes

- Add `scripts/gtd-title-eval/run.ts` for bounded generation, caching, repeats, and local result files.
- Add `scripts/gtd-title-eval/score.ts` for separated navigation and factual grading.
- Add `scripts/gtd-title-eval/run.test.ts` for accounting and mutation isolation.

Call only the pure production planner/formatter and measured inference transport. Never construct `createThreadNamer` in the evaluator. Its typed dependencies cannot expose `threads.update` or a mutable thread client. Retain the current baseline implementation by source hash in local artifacts. Avoid a second permanent naming implementation.

## Data structures

`NamingAttempt` records policy/case hashes, model/effort, title, usage, elapsed time, error, and fallback position. `EvaluationResult` reports paired metrics and gate results without hiding unknowns.

## Verification

Static: deterministic tests for budget exhaustion, unknown usage, cache identity, explicit repeats, and absent mutation capability.

Runtime: prove the evaluator separates a correct title, a wrong-subject title, and a false-shipped title. Then run the baseline and validate a result record against the actual host response. Freeze the rubric after this sensitivity check and before candidate results.

Exit: rerunnable baseline command, trustworthy accounting, and a hard call/token stop.
