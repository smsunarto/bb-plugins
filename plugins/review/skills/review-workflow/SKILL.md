---
name: review-workflow
description: Start independent reviews with pinned targets and retrieve their results.
user-invocable: false
---

Use `review_start` with a summary stating the change's intent (what it should achieve and why). `kind` is implementation (default) or design. Modes select reasoning effort: quick (medium), standard (high, default), deep (max). Quick asks one reviewer from the other model family; Standard and Deep ask a panel of one Claude and one Codex reviewer with the same prompt. Optional `brief` and `evidence: [{label, path}]` supply context; evidence is captured from the calling host. Identify the revision or workspace state behind test results.

Implementation targets are `{branch}` for a checkpointed GitButler branch or `{base, head, upstream?}` for explicit revisions. Checkpoint only authorized changes. `HEAD` and `gitbutler/workspace` are combined state, not review targets. Design reviews can use just a summary and optional brief.

For the publication candidate, use `kind: "implementation", mode: "deep", scope: "publication"`. Branch publication scope includes ancestors back to the merge base; segment scope reviews the branch's owned commits. Explicit publication comparisons must cover that full delta. Outside GitButler, supply `upstream` and use its merge base with head as `base`.

`reuse:auto` preserves an eligible reviewer's context; `reuse:new` requests fresh judgment. Reuse the completed run at push, PR update, and merge when the candidate is unchanged; retrieve its result rather than starting another review. A changed candidate needs a new assessment. Descendant helpers in the same environment can inherit the assessment.

BB sends completion and failure notifications to the parent, one per reviewer for a panel. Continue other work or yield, then call `review_result({runId, waitSeconds:0})` after a notification, or immediately for an already-completed run; expect `running` until every reviewer finishes. Do not poll. The result validates execution, candidate freshness, and complete diff reads for Deep implementation reviews; notification text alone is not publication clearance.

The result has one report per model in `reviews`. Synthesize them before judging: merge findings that describe the same issue, note which models raised each, treat independent agreement as the strongest signal, weigh a finding from one model alone on its evidence, and note disagreements. Publication clears only when every reviewer's report clears: any single reviewer's P0 or P1 blocks publication by design, and a rerun reviews with the full panel again.

Judge the findings as a pragmatic lead, not an aggregator. Classify each as Act on (real correctness, security, or maintainability issue for the actual goal), Consider (legitimate, but its cost now is uncertain), Noted (valid, not actionable yet), or Dismissed, each with a one-line reason. Structural regressions the code-quality lens lists (missed simplification, a file pushed past 1k lines, ad-hoc branching, duplicated helpers, logic in the wrong layer) default to Act on unless justified; they still do not block publication on their own. Filters: a review of only nits means the code is probably fine; a hypothetical input is a finding only if a caller can produce it, so trace the call site; an abstraction for code that has no second use is premature; "I would have done it differently" without a concrete problem is not a finding; dismiss findings that show missing context, such as code the change did not touch or patterns consistent with the codebase. Scrutinize correctness and security findings harder before dismissing them. Dismissing a P0 or P1 does not clear the publication gate: fix it, or rerun the review with evidence or a brief explaining why it is not an issue. When reporting to the user, surface Consider items and say in one sentence where the models agreed and disagreed.

`review_context` exposes the brief, evidence, diff, tree, pinned files, and report. Its `nextOffset` continues paginated content.

CLI equivalents: `bb review start --mode <mode> --branch <branch> --prompt <summary>`, `bb review result <run-id>`, and `bb review context <run-id> --section <section>`. Use `--scope publication` for publication and `--base`, `--head`, `--upstream` for explicit targets. Manual `/review-quick`, `/review-standard`, and `/review-deep` are user-only.
