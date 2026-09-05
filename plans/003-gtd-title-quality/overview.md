# GTD title quality hillclimb

Status: proposed plan. No naming code, repository setup runs, or generation experiments have been executed for this plan.

## Outcome

Help Scott find the right work thread among many similar threads. A successful title identifies the current substantive task, its scope, and its supported activity. Put distinguishing information early enough to survive sidebar truncation.

Keep recurring title inference tool-free, fast, and within the measured token usage of the current implementation. Explore each repository separately, once, to distill compact naming rules using Luna at max effort.

## Evidence and recommendation

Start with context selection and title formatting at the current low effort. Test higher reasoning only if those changes leave errors that require reasoning. This is a hypothesis to measure, not a demonstrated benchmark win.

| Current implementation                                                                            | Consequence                                                                       |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Luna low, 5-second attempts, Mini fallback](../../plugins/gtd-sidebar/thread-title-inference.ts) | A higher effort must justify its latency and tokens, including fallback attempts. |
| [36-character limit and UTF-16 truncation](../../plugins/gtd-sidebar/lib/thread-naming.ts)        | The preferred emoji, scope, and distinguishing task often cannot fit.             |
| [First automatic turn omits handoff](../../plugins/gtd-sidebar/lib/thread-naming.ts)              | Continuation requests can lose their strongest subject evidence.                  |
| [Forced naming uses the initial request](../../plugins/gtd-sidebar/lib/thread-naming.ts)          | Manual generation can describe an obsolete task.                                  |
| [Only final title JSON is returned](../../plugins/gtd-sidebar/host/inference/chatgpt-client.ts)   | Current records cannot establish token cost or generation quality by model.       |
| [Existing workspace configuration](../../.agents/GTD_TITLE.md)                                    | `.agents/GTD_TITLE.md` is an existing user-facing contract requiring migration.   |

The earlier local review sampled 104 applied title updates across 39 root threads over 72 hours. They include mixed naming sources, not captured requests to this generator. Examples lost Laminar, BB Connect, pstack, and Pokémon GO subjects. A Monaco feasibility question became an implementation title. The sample motivates cases but cannot isolate the benefit of reasoning effort.

Only one later-turn handoff in that sample exceeded 4,000 characters. Increasing the handoff cap alone is therefore a weak first hypothesis. Retained logs contained 168 naming errors, mostly rate limits, without a success denominator. They do not establish a failure rate.

## Agreed behavior

The [heuristics](heuristics.md) are the product contract. Examples include:

- `🧪 [GTD Sidebar] Title accuracy vs cost`
- `[Monaco] Can TextMate work?`
- `🐛 [GTD + Vimium] Sort & focus fixes`
- `🚀 [GTD Sidebar] Waiting sort fix`
- `☑️ [GTD Sidebar] Waiting sort fix`, only after successful completion of an explicit `ship it` request.

## Scope and boundaries

Include a reproducible offline evaluation, compact context packing, repository naming setup, phase formatting, and verified integration of the winning policy. Use bb-plugins, dotfiles, bb, recipe, world-engine, and pgo as the initial repository sample.

The generator receives every fact in its prompt. Server-side preparation may select existing events and load naming rules. The generator cannot inspect files, browse, read other threads, or spawn agents. Setup exploration does not run during renaming.

Keep raw thread history, prompts, evaluation outputs, and setup drafts in local task artifacts. Commit only the harness, synthetic or carefully de-identified fixtures, and deliberately adopted naming rules. Do not batch rename historical live threads during evaluation.

This plan does not authorize implementation now. It does not include Cloudflare changes, a general agent-memory service, or a sidebar redesign. Do not push or open a PR without the user's instruction.

## Design choices

| Approach                                             | Decision                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Increase reasoning with today's prompt               | Conditional later experiment. Cannot recover facts absent from input or fix deterministic clipping. |
| Pack better context into the existing token envelope | First choice. Include first-turn handoff, preserve the current subject, and remove redundant text.  |
| Inject full history and a large repository inventory | Reject for recurring inference. Conflicts with usage and latency constraints.                       |

Keep one naming pipeline and one canonical rules file. Start with the existing title-string result. Test structured activity/scope/task fields only if they solve measured errors that simpler formatting cannot handle within the budget.

The proposed configuration location is `.agents/GTD_NAMING.md`. This keeps the existing workspace convention while using the user's requested filename. Setup produces a reviewable draft. An explicit migration replaces the old file without silently discarding customized rules.

## Principles applied

- **Experience First** makes thread selection accuracy at visible sidebar widths the primary metric.
- **Build the Lever** produces a rerunnable dry-run evaluator before prompt tuning.
- **Foundational Thinking** defines snapshots and measurements before experiments.
- **Redesign from First Principles** replaces the imperative, 36-character contract with the agreed naming behavior.
- **Guard the Context Window** separates repository discovery from compact recurring context.
- **Prove It Works** requires the actual card and slim-row surfaces, alongside model evaluation.
- **Sequence Work into Verifiable Units** gives each phase a small ownership boundary and explicit exit gate.

These are the corresponding `principle-*` skills in the installed pstack package. Read their leaf instructions when applying them.

## Phases

| Phase                                          | Deliverable                                 | Status |
| ---------------------------------------------- | ------------------------------------------- | ------ |
| [1. Freeze cases](phase-01-cases.md)           | Provenance, labels, and held-out split      | TODO   |
| [2. Capture usage](phase-02-usage.md)          | Measured provider usage                     | TODO   |
| [2b. Record attempts](phase-02-attempts.md)    | Retry and latency accounting                | TODO   |
| [3. Build evaluator](phase-03-evaluator.md)    | Repeatable dry-run baseline                 | TODO   |
| [4. Improve context](phase-04-context.md)      | Bounded candidate context                   | TODO   |
| [5. Define naming rules](phase-05-rules.md)    | Compact configuration contract              | TODO   |
| [6. Distill repositories](phase-06-setup.md)   | One-time Luna max setup experiment          | TODO   |
| [7. Format titles](phase-07-format.md)         | Phase, scope, and Unicode behavior          | TODO   |
| [8. Hillclimb](phase-08-hillclimb.md)          | Budget-qualified winner or no-win result    | TODO   |
| [9. Integrate winner](phase-09-integration.md) | Protected runtime path                      | TODO   |
| [10. Migrate and verify](phase-10-rollout.md)  | Documentation, rules, and live verification | TODO   |

Phases 4–7 supply opt-in candidates to the evaluator. Do not select them for live naming before phase 8 passes. Reuse the production planner and formatter in the evaluator. Keep the frozen baseline as an evaluation artifact, then delete rejected candidate branches before integration. Split a phase further if its chosen implementation exceeds three source/test files or five distinct behavior cases.

## Verification and implementation guidance

The [testing protocol](testing.md) defines proposed numerical gates, usage ceilings, and stop conditions. Freeze them before looking at candidate scores. No numerical improvement is claimed by this plan.

Invoke `bb-plugin-authoring`, `verify-bb-plugins`, `control-cli`, and `agent-browser` for their corresponding implementation and runtime surfaces. Use `bb-cli` for thread context and `but` for version control. Start `bun run dev` before the first plugin edit and leave it running.

Apply pstack **how** to each unfamiliar subsystem, **interrogate** to contested designs, **deslop** before commits when installed, **unslop** to prose, and **show-me-your-work** to the experiment decision trail. Use the **Babysit** playbook only for an authorized PR follow-up. Domain ownership remains server-side. Preserve manual-title, archive, child-thread, disable-setting, and concurrency protections.

After focused verification, run `bun run lint:fix && bun run fmt && bun run typecheck && bun run test`. Preserve unrelated work. Checkpoint only this task's accepted changes on `scott/gtd-title-quality`. Use the isolated dev-instance verification workflow before any authorized live plugin reload. Phase 10 describes rollback and the handoff evidence.
