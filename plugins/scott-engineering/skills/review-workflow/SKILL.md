---
name: review-workflow
description: Ask independent reviewers to challenge a change, then synthesize a verdict.
user-invocable: false
---

# Review workflow

Use independent reviewers to find blind spots. The deliverable is a reasoned verdict. A review request does not authorize applying fixes or publishing changes.

## When to review

Start a review automatically when implementation is ready for handoff, after relevant checks and checkpointing only authorized changes. Review consequential designs before dependent implementation. Do not wait for the user to ask or request permission to start; honor an explicit request to skip review. Also review when the user asks.

Review a completed unit of work once. Reuse a completed, current assessment for unchanged work; do not repeat it just because a turn ends, an intermediate checkpoint is saved, or the same work is pushed, added to a PR, or merged. After addressing findings, review again when it would resolve a material uncertainty.

## 1. Scope and intent

Identify the change from the user's request. State what it should achieve and why in one paragraph.

For implementation, pass `target: {branch}` with the specific GitButler branch that owns the work. The review includes that branch and its ancestors, excluding other applied stacks, branches above it, and uncommitted files. Use `{base, head}` for a specific comparison. Checkpoint only authorized changes. Never infer the review target from the checked-out branch: `HEAD` and `gitbutler/workspace` combine other work and are rejected. For a proposal, use `kind: "design"` and put the proposal in `brief`.

## 2. Ask reviewers

Call `scott_engineering_review_start({summary, target})` without choosing a mode unless the user requests one. The default review asks one Claude and one Codex reviewer, independently, with the same intent and rubric. Model diversity supplies the different perspectives; do not assign personas.

Add `brief` or `evidence: [{label, path}]` when needed. Name the revision or workspace state behind test results.

## 3. Collect and synthesize

If `scott_engineering_review_start` returns `status: "completed"`, call `scott_engineering_review_result({runId})` immediately; a cached run sends no new notification. Otherwise wait for BB's completion notifications, then call `scott_engineering_review_result({runId})`. Continue other work while reviewers run; do not poll. The result stays `running` until every reviewer finishes. Read large reports through `scott_engineering_review_context({runId, section: "report"})`, following `nextOffset`.

Merge duplicate findings, attribute them to the models that raised them, and note disagreements. Independent agreement is a strong signal, not a vote. A lone correctness or security finding still deserves scrutiny. Report missing reviews and verification limits; `current: false` means the target changed after review.

## 4. Lead judgment

Judge each finding against the actual goal and code. Trace alleged failures through callers. Dismiss impossible inputs, personal preferences, premature abstractions, and claims that miss the surrounding context. Treat structural maintainability problems seriously when they impose a concrete cost.

Classify findings with a one-line reason:

- **Act on**: a real correctness, security, or maintainability issue worth fixing.
- **Consider**: a legitimate concern whose benefit may not justify its cost now.
- **Noted**: valid context with no useful action at this stage.
- **Dismissed**: wrong, speculative, or missing context.

Give the intent, reviewer names, classified findings, and a short account of agreement or disagreement. Omit empty buckets. If there are no actionable findings, say so. Severity labels inform judgment; they do not create an automatic veto or require a rerun to dismiss a finding.

Stop at the verdict for a review-only request. When fixes are already authorized, address accepted findings and verify the changes. Automatic review does not introduce publication gates or require a fresh review at every checkpoint, push, PR update, or merge.

## Reference

`scott_engineering_review_context` reads the brief, captured evidence, pinned diff, tree, files, and reports. Reviewers stay read-only and use those pinned sources.

Repeating an identical unsettled request returns its existing run. An unchanged completed request can return a completed receipt; collect its result immediately. The plugin manages reviewer reuse; `reuse: "new"` requests fresh judgment. Distinct requests can run concurrently.

CLI: `bb scott-engineering review-start --branch scott/feature --prompt 'Intent' --json`. Read the receipt's `status`: call `bb scott-engineering review-result <run-id>` immediately for `completed`, otherwise wait for notification. Use `--base` and `--head` for an explicit comparison. `/review-quick`, `/review-standard`, and `/review-deep` are user-only shortcuts.
