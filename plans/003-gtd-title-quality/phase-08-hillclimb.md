# Phase 8. Select a budget-qualified winner

[Plan overview](overview.md) · [Evaluation protocol](testing.md)

## Goal

Determine whether context, formatting, rules, or reasoning improve navigation under the usage and latency limits.

## Changes

- Add the candidate matrix in `scripts/gtd-title-eval/variants.ts`.
- Extend `scripts/gtd-title-eval/run.ts` only for missing evaluation controls.
- Keep the local `decision.tsv` and result artifacts outside tracked source.

Follow the six-attempt screening schedule, finalist repeats, and sealed holdout in the testing protocol. Change one mechanism per candidate. Prefer low effort until a reasoning-dependent error remains. A failed budget gate rejects the candidate even when its titles read better.

If medium effort is warranted, first isolate its contract extension and validation as a separate small phase touching `lib/host-contract.ts`, its existing contract tests, and the evaluation adapter. Keep live defaults unchanged. Validate actual model support, then compare identical prompt/context/schema against low effort. Do not conflate a prompt improvement with a model change.

## Data structures

`NamingVariant` names a precise context/format/rule/model policy with a content hash. `CandidateDecision` records acceptance or rejection against every frozen gate.

## Verification

Static: deterministic reproduction from case and policy hashes. Confirm the evaluator can stop before exceeding either call or token ceilings.

Runtime: paired low-effort experiments, controlled effort comparison if justified, and held-out evaluation exactly once. Report disagreements and intervals. Inspect the worst titles, not just the average.

Exit: a passing winner with an attributable mechanism, or a documented no-win/inconclusive result. A no-win result stops promotion. Do not loosen the gates or claim the task is optimized because the budget ran out.
