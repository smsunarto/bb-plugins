# GTD title hillclimb result

> **Superseded (2026-09-05).** The structured `Emoji [Scope] Task` output
> described below was replaced by a keep-or-rename decision in which the model
> returns the complete title, and naming now runs on each user prompt instead
> of on turn completion. Only `.agents/GTD_NAMING.md` is read; the
> `.agents/GTD_TITLE.md` fallback, never released, was dropped. The evaluation
> harness and its synthetic fixtures were
> removed once the pilot was complete; they are preserved in commit `6512fc16`
> as `scripts/gtd-title-eval.ts` and `scripts/gtd-title-fixtures.json`.

Implemented the compact structured candidate with Luna reasoning disabled. Stopped the initial pilot at the reduced 32-attempt budget, then ran two historical checks after explicit approval. This is a useful pilot, not proof of convergence or a navigation benchmark.

## What changed

- Inject the latest request, a short follow-up anchor, handoff, and compact repository scope rules. Combined context is capped at 2,400 characters.
- Generate named activity, scope, and task fields. Assemble `Emoji [Scope] Task` locally, with a 48-character task target and a defensive 96-grapheme total limit.
- Require explicit successful `ship it` evidence for ☑️. Keep exploration and questions without an emoji. Preserve manual title edits and reject automatic results when a newer request arrives during inference.
- Keep the existing Luna primary, Mini fallback, five-second attempt deadline, and one transient retry. Record available usage and attempt timing without logging production prompts.
- Adopt `.agents/GTD_NAMING.md` for bb-plugins. Keep `.agents/GTD_TITLE.md` as a missing-file fallback for existing projects.

## Small pilot

The user reduced the original comprehensive proposal before execution. Automatic approval review rejected replaying history-derived prompts, including a retry citing the standing trusted-service authorization. All 32 initial inference attempts used entirely synthetic fixtures. There were no model graders and no live historical batch renames.

| Variant                           | Physical attempts | Observation                                                                    | Decision    |
| --------------------------------- | ----------------: | ------------------------------------------------------------------------------ | ----------- |
| Baseline, low                     |                 7 | Lost the export subject; multi-scope case timed out twice                      | Reference   |
| Compact context v1, low           |                 4 | Recovered scope but anticipated verification                                   | Reject      |
| Shorter prompt v2, low            |                 7 | Better task subjects; formatting and phase errors remained                     | Refine      |
| v2, none                          |                 3 | Less output and lower latency; same formatting weakness                        | Keep none   |
| Explicit formatting v3, none      |                 3 | Brackets improved inconsistently                                               | Reject      |
| Structured emoji fields, none     |                 3 | Stable brackets; confused review with verification                             | Refine      |
| Structured named activities, none |                 5 | Both scopes retained, review classified correctly, failed shipping withheld ☑️ | Adopt pilot |

Final transport outputs, with the local formatter's tested leading-verb cleanup:

- `🛠️ [Invoices] CSV export implementation`
- `🛠️ [Catalog + Analysis] Astronomy catalog query skill`
- `🛠️ [Invoices + Accounts] Invoice sorting and account selection`
- `🔎 [Snapshots] Snapshot writer races`
- `🛠️ [Invoices] Invoice sorting fix`

The multi-scope fix received the broader build activity instead of the more specific fix activity. Scope choices and phase specificity still need ordinary-use feedback. Leading-verb cleanup was verified deterministically after the model calls, without another inference round.

Only two successful baseline/final cases were directly paired (export and skill):

| Measure                    | Baseline |  Final |
| -------------------------- | -------: | -----: |
| Input tokens, sum          |      516 |    520 |
| Input + output tokens, sum |      570 |    569 |
| Mean transport time        |   2.93 s | 1.77 s |

This is roughly flat total tokens and a 40% latency reduction on two examples. It does not establish input-token parity, p95 performance, or general accuracy. Final five-case median transport time was 2.25 seconds, with no fallback. Queue and UI update time were not included.

Across the initial synthetic search, 28 attempts reported 7,195 input and 1,328 output tokens (8,523 total). Four failed attempts had unknown usage. Reasoning is already included in output and is not counted twice. Provider token counts do not establish subscription quota charging.

## Approved historical follow-up

After explicit authorization to send history-derived prompts to OpenAI/Codex, two reconstructed historical checkpoints ran once each with the final Luna/none candidate. There were no retries, live title writes, or additional model graders. This brings the total to 34 physical attempts: 32 synthetic and two historical.

| Case               | Result after local prefix correction                  | Input | Output | Transport time |
| ------------------ | ----------------------------------------------------- | ----: | -----: | -------------: |
| pstack roles       | Preserved the tool subject and role-summary task      |   420 |     29 |         1.39 s |
| Monaco feasibility | Preserved the editor subject and feasibility question |   517 |     37 |         1.89 s |

Both retained their subjects and used exploration activity. The Monaco question stayed a question. The model put an additional `[Monaco Editor]` prefix inside the title field, following the legacy repository rules. The formatter now removes a matching repeated scope, including a scope followed by `plugin`, while retaining unrelated labels such as `[RFC]`. That correction was verified with deterministic regression tests, without another inference call.

These checks used 1,003 total tokens with no reasoning tokens. Combined with the synthetic pilot, 30 measured attempts used 9,526 tokens; four earlier failed attempts still have unknown usage. There was no paired historical baseline, so this follow-up does not establish an improvement percentage. The remaining verbose scope wording is a modest quality limitation. Stop here and gather feedback during ordinary use.

## Repository setup

One Luna/max exploration pass produced rule drafts for bb-plugins, dotfiles, bb, recipe, world-engine, and pgo. Setup token telemetry was unavailable, so no amortization claim is made. Only the bb-plugins rule was adopted. The other five drafts remain local review artifacts and were not validated by title generation. No repository exploration runs during recurring naming.

## Reproduce a small synthetic run

The harness that produced these numbers has been removed. Check out commit
`6512fc16` for `scripts/gtd-title-eval.ts`, the synthetic fixtures, and the
planner they ran against. The original historical snapshots, frozen candidates,
setup drafts, decision ledger, and measured results remain in the pilot
thread's private `gtd-hillclimb` artifact directory. They are excluded from the
commit.

## Verification

The repository lint, formatting, typecheck, and full test commands passed. The 56 focused naming and usage tests cover context selection, grapheme limits, shipping eligibility, file migration, fallback behavior, queued naming, and stale/manual title protection.

An isolated source-built BB instance loaded the local plugin. Chrome verification showed the longer multi-scope title with both scope names and the first task words visible, while its accessible link retained the complete title. The synthetic fixture was queued in the future and deleted without running inference. This was a rendering check, not a full live generation test or a human navigation experiment. No slim-row or alternate-width benchmark was run.

The all-plugin watcher hit an unrelated agent-trace configuration gate. A GTD-only watcher and separate isolated runtime were used for verification.
