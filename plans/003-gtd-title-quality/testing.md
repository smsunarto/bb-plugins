# Evaluation and verification protocol

[Plan overview](overview.md)

Execution note: the user reduced this protocol before execution. The actual run used 32 physical inference attempts, entirely synthetic cases, no model grader, and one setup exploration across six repositories. See [results](results.md) for scope and limitations. The comprehensive protocol below was not executed.

All numeric values below are proposed defaults. Freeze the workload, gates, and budget before candidate scores are visible. Report uncertainty honestly. A small pilot is not statistical proof of a universal improvement.

## Frozen workload

Build 48 eligible rename checkpoints from at least 24 distinct threads where available. Deduplicate by thread and event ID. Keep all checkpoints from a thread in one partition.

- Development: 36 cases from bb-plugins, dotfiles, bb, and recipe. Designate 12 difficult cases for cheap screening.
- Held-out: 12 cases. Reserve six unseen threads or scopes from the development repositories and six from world-engine and pgo.
- Sparse repositories: pgo has very little observed title history. Keep any synthetic stress cases separate from observed-case scores. If the real sample cannot meet these counts, freeze the smaller sample and reduced claims before running candidates.

Extract read-only snapshots using the supported BB thread/event interface where practical. A read-only local database export is acceptable when needed. Never infer unavailable event-time facts from a thread's current state. Reconstruct only context available at the rename checkpoint. Mark reconstructed prompts separately from exact captured requests.

Freeze initial request, latest substantive request, latest user steering, completed assistant handoff, current title at that instant, available scope rules, and any explicit shipping evidence. Record provenance, completion boundaries, and exclusions. Do not inject future outputs, reference titles, labels, or evaluator comments.

Cover question versus implementation, first-turn continuation, short follow-up, task change, multi-scope work, code review, refactor, verification, readiness, successful `ship it`, failed shipping, and stale/manual-title races. Keep system-policy cases in deterministic tests when they do not require model calls.

Repository setup receives bounded repository material only. It cannot see evaluation answers or title history. Freeze setup prompts using development repositories, then apply the same procedure to repository holdouts. Holdout repository inspection by setup is allowed because setup is the capability being tested. Holdout title outcomes cannot inform tuning.

## Quality metrics

The primary metric is correct thread selection from the visible title. Each case gets a short task cue and a list containing the candidate title plus five plausible sibling titles. Freeze distractors for all variants, match their style, and randomize position. A distinctive emoji alone must not reveal the correct answer. Use separate cues from reference titles to avoid exact-string matching.

Capture the normal and narrow sidebar title widths from the real UI. Render candidate titles using the real font and equivalent clipping. Grade selection from that visible result. Also score the full stored title so clipping and semantic failures remain distinguishable. This is a navigation proxy. Only user trials can establish actual human selection time.

A grader receives the cue and visible list for navigation, without the answer key or original conversation. A separate accuracy grade receives the frozen facts and candidate. Keep model identity and variant names hidden. Counterbalance pairwise order. Use a fixed, tool-free grader for the pilot and record its identity, prompt, and effort. No grader runs in production.

Calibrate disputed judgments with up to six user-facing multiple-choice comparisons. Label obvious cases directly from the interview contract. Report subjective disagreements instead of turning one model's preference into ground truth.

Report these separately:

| Measure                                     | Better direction               |
| ------------------------------------------- | ------------------------------ |
| Visible-title navigation accuracy           | Higher                         |
| Correct subject and substantive scopes      | Higher                         |
| Correct question/activity/phase             | Higher                         |
| Distinguishing detail preserved             | Higher                         |
| Unsupported scope, work, or progress claims | Zero                           |
| False ☑️ or repository-name scopes          | Zero                           |
| Unnecessary rename on equivalent follow-up  | Lower                          |
| Missed substantive task or phase changes    | Zero on labeled contract cases |

Do not conceal failures inside a single weighted score. A hard accuracy violation cannot be traded for shorter latency.

## Cost and latency

Measure provider input, cached input, output, and reasoning tokens, plus total wall time and every attempt. Reasoning tokens may be included in reported output tokens. Count them once. Retain the raw usage fields so accounting is auditable. Missing usage remains unknown, never zero. Treat cached input as a subset only when the provider contract establishes that meaning. Exact validated prompt tokenization can fill an input-size gap. It cannot recover hidden reasoning or establish total-token parity. Unknown total usage blocks the total-token gate.

Compare paired cases and the same fallback policy. Count failures and retries in usage per eligible rename opportunity, not only successful titles. Report completion rate, usage per successful rename, median/p95 end-to-end latency, and fallback frequency alongside the primary figures. Avoid an optimization that saves usage merely by missing necessary renames.

Recurring acceptance requires both mean and p95 input tokens, and mean and p95 total tokens, to be no greater than the frozen baseline on paired cases. Also inspect short-prompt and long-handoff strata. Savings in one must not conceal a large regression in the other. A usage-equivalent limit does not imply equal subscription quota charging across models, so label that limitation.

Latency acceptance requires no worse median or p95 than the paired baseline. Keep the existing 5-second per-attempt deadline. A failed primary followed by its 250ms delay and another 5-second attempt can already exceed ten seconds plus overhead. Offline transport timing measures service latency only. Runtime timing starts before the per-thread queue and ends at the write or terminal skip/failure. Report both, and do not advertise a 5-second end-to-end limit or infer queue latency from a dry-run transport call.

Setup is reported separately. Proposed cap: six Luna/max setup sessions, each with at most 12,000 injected source tokens and 20,000 total measured tokens. Stop a run that exhausts its limit. Show setup amortization at 100 and 1,000 renames. Never hide it in recurring savings or run setup automatically to amortize a theoretical benefit.

## Bounded search

Cache results by full case, policy, model, effort, schema, and rule hashes. Include the repetition ID for deliberate repeats. Caching must not eliminate the stochastic repeats needed for validation.

1. Run the current baseline once on all 48 cases. Keep held-out outputs sealed.
2. Screen six single-mechanism candidates on the 12 development cases. Suggested order is format budget, first-turn handoff, task anchor and compact history, repository rules, removal of redundant prompt text, then output structure or effort if indicated.
3. Evaluate only the selected finalist on the remaining 24 development cases.
4. Repeat the baseline and finalist on the 12 screening cases once each.
5. Unseal the 12 held-out cases once and compare the finalist with the baseline.

This schedule uses at most 180 logical title generations before retries. Cap physical inference attempts at 200 and measured title-evaluation usage at 300,000 total tokens, whichever comes first. Bound offline grading separately at 60 batched calls and 200,000 total tokens. Setup has its separate ceiling above. Count probes, invalid outputs, fallbacks, and retries against their budgets. Refine or shrink the pilot before launching it if a baseline probe predicts exceeding these ceilings.

The six attempts are an experiment floor, not a demand to waste calls after a known budget blocker. Each needs a concrete error mechanism and a recorded accept/reject decision. A successful candidate becomes the development incumbent only if it passes accuracy, cost, and latency gates. Reuse baseline and incumbent results for paired comparisons. Fix seeds where supported and counterbalance run order to reduce time-of-day bias.

Try `none` versus `low` or a compact structured output within the existing interface first when appropriate. Test Luna `medium` only when errors plausibly require reasoning and budget remains. The production host contract currently allows only `none` and `low`. A medium experiment needs a separately verified evaluation contract and corresponding validation before a call. Never send an unsupported value, silently substitute another model, or assume max belongs in recurring inference.

## Decision and stop rules

Target at least a 10-percentage-point development navigation gain and at least two additional correct held-out selections out of 12, with no hard-contract failures and all usage/latency gates passing. Report paired win/loss counts and thread-clustered uncertainty intervals. If the baseline is near the ceiling, report that the target was unattainable for this sample. Do not lower the gate after observing the result.

Stop after six substantive attempts and finalist validation if the target passes. Otherwise stop at the budget ceiling or after three distinct mechanisms fail to improve the incumbent. Return a no-win or inconclusive result. Do not label a budget stop as convergence. If a finalist fails held-out evaluation, retain the incumbent production behavior and define new independent cases before further tuning.

Use one local decision record per attempt with hypothesis, change, hashes, quality counts, usage, latency, failure category, and accept/reject reason. Keep `decision.tsv`, snapshots, and raw results in the local run directory. Commit one accepted change at a time using GitButler. Do not commit raw private transcripts.

## Runtime verification

Follow the installed `verify-bb-plugins` skill and its GTD feature guide. Start the watcher, launch an isolated run, use its emitted runtime configuration, and route at least one BB command through `bb-kit dev-instance exec --`. Do not guess app/server ports.

Before the browser's first open, set viewport 1728 × 1117 at scale 2. Verify normal cards and slim rows at ordinary and narrow sidebar widths. Inspect screenshots, full accessible labels, search by distinguishing words, questions, multi-scope titles, and grapheme integrity. Capture before/after evidence on the same surface.

Exercise automatic idle naming, forced generation, first-turn continuation, a concurrent manual title edit, a queued automatic request, disabled automatic naming, and archived/child-thread exclusions. Verify that the inference request contains no tools and all required context is injected. Test shipping state transitions using controlled fixtures without actually shipping unrelated work.

Run focused tests per phase, then the repository's lint, format, typecheck, and test gates. After dev-instance verification, confirm the live plugin source is this local checkout and reload only `gtd-sidebar`. Verify one controlled thread through its visible title and usage record. Do not mass-rename old threads. Keep the last passing implementation available for a scoped rollback and reload if the runtime check fails.
