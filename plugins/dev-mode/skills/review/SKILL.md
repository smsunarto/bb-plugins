---
name: review
description: Review a change with one Claude and one Codex reviewer, fix accepted findings, and verify the result.
argument-hint: "[branch, plan, or review focus]"
---

# Review

Stop at a verdict when the user says not to modify, such as read-only or report-only.

## Ask

For a change, commit it on this task's branch. Its head is the branch tip, and its base is `git merge-base <target remote branch> <branch>`, so a stack includes the branches below it. Never use `HEAD` or `gitbutler/workspace`; they mix in other work. For a design, the proposal goes in the prompt.

Ask one Claude and one Codex reviewer, as Dev Mode's thread instructions describe, titled `Review (Claude)` and `Review (Codex)`. The prompt holds the intent in one paragraph, the base and head commits or the proposal, any focus or evidence, this brief, and, for a code change, the text of this skill's `references/rubric.md` and `references/code-quality.md`:

> You are an adversarial reviewer. Assume the stated goal is right and challenge the execution: bugs, design flaws, security issues, and maintainability problems. Do not praise. Read the change with `git diff <base> <head>` and files at head with `git show <head>:<path>`; do not check out commits. Apply the review lenses below, if any. Skip pre-existing issues, speculation, and style preferences. Report each finding with severity (P0 critical failure, P1 correctness bug, P2 design or maintainability problem, P3 minor), a `file:line` or plan section, the failure path, and a fix. State what you reviewed and what you could not verify. No findings is a valid result.

## Judge and fix

Wait for both reviewers. Merge duplicate findings and note which model raised each. Check every finding against the code: act on real problems, and dismiss wrong or speculative ones with a reason. Fix accepted findings on this task's branch without touching other work, then rerun the relevant checks. For a design, correct the proposal instead. Report the reviewers, what you fixed, the verification results, and any findings you left with your reasons.

Then settle each child as Dev Mode's thread instructions describe, including in read-only reviews.
