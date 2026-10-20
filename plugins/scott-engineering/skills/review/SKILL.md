---
name: review
description: Review a change with independent reviewers, fix accepted findings, and verify the result.
argument-hint: "[branch, plan, or review focus]"
---

# Review workflow

Use independent reviewers to find blind spots, then have the parent fix accepted findings and verify the result. This is the default for automatic reviews and requests such as "run review" or `/review`. Stop at a verdict when the user explicitly says not to modify, such as read-only, review-only, report-only, or "just tell me what's wrong". Review alone adds no publishing permission; preserve any authorization already given for the task.

## When to review

Start a review automatically when implementation is ready for handoff, after relevant checks and checkpointing only authorized changes. Review consequential designs before dependent implementation. Do not wait for the user to ask or request permission to start; honor an explicit request to skip review. Also review when the user asks.

Review a completed unit of work once. Use an existing completed assessment for unchanged work; do not repeat it just because a turn ends, an intermediate checkpoint is saved, or the same work is pushed, added to a PR, or merged. After addressing findings, review again when it would resolve a material uncertainty.

## 1. Scope and intent

Identify the change from the user's request. State what it should achieve and why in one paragraph.

For implementation, pass `target: {branch}` with the specific GitButler branch that owns the work. The review includes that branch and its ancestors, excluding other applied stacks, branches above it, and uncommitted files. Use `{base, head}` for a specific comparison. Checkpoint only authorized changes. Never infer the review target from the checked-out branch: `HEAD` and `gitbutler/workspace` combine other work and are rejected. For a proposal, use `kind: "design"` and put the proposal in `brief`.

## 2. Ask reviewers

Call `scott_engineering_review_start({summary, target})`. Each review asks one Claude and one Codex reviewer, independently, with the same intent and rubric. Model diversity supplies the different perspectives; do not assign personas.

Add `brief` or `evidence: [{label, path}]` when needed. Name the revision or workspace state behind test results.

## 3. Collect and synthesize

BB sends each reviewer's final reply to the parent. Check the start receipt for launch errors and report any missing reviewers. If no reviewers started, do not wait for notifications. Continue independent work or yield until all launched reviewers finish or are known to have failed; do not poll. Treat failed or unusable reviews as missing, report the limitation, and proceed with the available findings. Do not start implementation that depends on a pending design review. If you need to retrieve a reply, use `bb thread output <thread-id>` with the reviewer thread ID returned by start.

Merge duplicate findings, attribute them to the models that raised them, and note disagreements. Independent agreement is a strong signal, not a vote. A lone correctness or security finding still deserves scrutiny. Report missing reviews and verification limits. The review covers its original pinned target; compare it with the current change before relying on it.

## 4. Lead judgment

Judge each finding against the actual goal and code. Trace alleged failures through callers. Dismiss impossible inputs, personal preferences, premature abstractions, and claims that miss the surrounding context. Treat structural maintainability problems seriously when they impose a concrete cost.

Classify findings with a one-line reason:

- **Act on**: a real correctness, security, or maintainability issue worth fixing.
- **Consider**: a legitimate concern whose benefit may not justify its cost now.
- **Noted**: valid context with no useful action at this stage.
- **Dismissed**: wrong, speculative, or missing context.

Severity labels inform judgment; they do not create an automatic veto or require a rerun to dismiss a finding.

## 5. Fix and verify

After collecting the reviews, the parent applies **Act on** findings within the reviewed scope and runs relevant checks. Continue the task when completion notifications arrive; they are work to act on, not just messages to relay. Do not end with a verdict, offer to fix later, or request approval again for routine fixes. The independent reviewers stay read-only so they cannot make competing edits in the shared checkout. Put fixes on this task's branch and preserve unrelated work; reviewing ancestor or other authors' branches does not authorize rewriting those branches or absorbing their uncommitted changes.

Honor any explicit instruction not to modify. Ask only when a finding requires a consequential product decision, destructive action, or work beyond the reviewed scope; finish independent fixes first. For a design review, correct the proposal without starting unrequested implementation. Re-review changed code when it would resolve a material uncertainty, using a new pinned target. Checkpoint fixes according to the task's existing instructions; publish them when the task already authorizes it.

The final handoff gives the intent, reviewer names, what was fixed, verification results, commit/publication state, and any remaining classified findings with reasons. Summarize agreement or disagreement and omit empty buckets. If there are no actionable findings, say so. Automatic review does not introduce publication gates or require a fresh review at every checkpoint, push, PR update, or merge.

## Reference

`scott_engineering_review_context` reads pinned diffs, trees, and files. Reviewers receive the brief and evidence in their initial prompt, stay read-only, and use those pinned sources.

Each start launches new BB subthreads. Do not repeat a start while those reviewers are working. If a launch response is lost or contains errors, run `bb thread list --parent-thread <parent-id> --include-hidden --json` and inspect the review children before retrying. Use `bb thread show <id>` to inspect a child's origin when needed. A partial launch leaves the successful children running; do not restart the whole panel. Use BB's ordinary thread messaging to clarify findings about the original pinned candidate. To review code changed since that candidate, checkpoint the changes and call `scott_engineering_review_start` again; an existing reviewer's context remains pinned to its original commits. BB owns retries, notifications, status, and conversation history; there is no separate review database or result cache.

CLI: `bb scott-engineering review-start --branch scott/feature --prompt 'Intent' --json`. BB notifies the parent as reviewers finish; retrieve a reply with `bb thread output <thread-id>`. Use `--base` and `--head` for an explicit comparison. `/review` invokes this workflow.
