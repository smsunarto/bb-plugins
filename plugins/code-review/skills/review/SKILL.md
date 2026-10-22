---
name: review
description: Review a change with one Claude and one Codex reviewer, fix accepted findings, and verify the result.
argument-hint: "[branch, proposal, or focus]"
---

# Review

Stop at a verdict when the user says not to modify, such as read-only or report-only.

## Ask

This skill authorizes starting one Claude and one Codex review child with the commands below.

For a change, commit it on this task's branch. Its head is the branch tip, and its base is `git merge-base <target remote branch> <branch>`, so a stack includes the branches below it. Never use `HEAD` or `gitbutler/workspace`; they mix in other work. For a design, the proposal goes in the prompt.

Give both reviewers the same self-contained prompt: the intent, pinned base and head commits or proposal, any user-requested focus or evidence, and the shared brief added by `bb review prompt`. Replace the placeholders before running. Use a short topic and revision in `review_label`; the temporary file's unique name identifies this review round, including reruns of the same revision.

```sh
review_label='<topic> @ <head-short-or-proposal-version>'
review_prompt=$(mktemp "${TMPDIR:-/tmp}/bb-review.XXXXXX")
review_run=${review_prompt##*/}
review_request=$(mktemp "${TMPDIR:-/tmp}/bb-review-request.XXXXXX")
cat > "$review_request" <<'REVIEW_REQUEST'
Intent: <what this change or proposal should accomplish>
Target: <base and head commit SHAs, or the complete proposal>
Focus and evidence: <requested focus, relevant checks, and known limits>
REVIEW_REQUEST
bb review prompt --request "$(cat "$review_request")" > "$review_prompt" || { rm -f "$review_prompt" "$review_request"; exit 1; }
rm -f "$review_request"

printf 'Review prompt: %s\nReview label: %s\nReview run: %s\n' "$review_prompt" "$review_label" "$review_run"

bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" \
  --provider claude-code --reasoning-level high \
  --title "Review (Claude) — $review_label [$review_run]" --prompt-file "$review_prompt" --json

bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" \
  --provider codex --reasoning-level high \
  --title "Review (Codex) — $review_label [$review_run]" --prompt-file "$review_prompt" --json
```

Each spawn returns immediately with the new thread's `.id`; it does not wait for the review. Record each ID with its provider, target, and the printed review run. Use those IDs for follow-up and cleanup, rather than looking up a thread by title. If one launch fails, keep the other and report it.

After both launch attempts, remove the prompt file with `rm -f '<printed-review-prompt-path>'`. Use the literal printed path in a later command; shell variables do not persist between tool calls.

BB sends each subthread's result to this parent automatically. Check either reviewer with `bb thread show <reviewer-id>` and read its answer with `bb thread output <reviewer-id>`.

## Judge and fix

Wait for both reviewers with `bb thread wait <reviewer-id> --timeout 9m`. Deny any permission request with `bb thread interactions deny <interaction-id> <reviewer-id>`; report a reviewer that remains stuck as missing. Merge duplicate findings and note which model raised each. Check every finding against the code: act on real problems, and dismiss wrong or speculative ones with a reason. Fix accepted findings on this task's branch without touching other work, then rerun the relevant checks. For a design, correct the proposal instead. Report the reviewers, what you fixed, the verification results, and any findings you left with your reasons.

## Finish

After consuming each answer and finishing any follow-up, run `bb thread archive <reviewer-id>`, then `bb thread stop <reviewer-id>`. Do this for every child started by this review, including read-only reviews and failed or abandoned attempts once no longer needed. Use the recorded child IDs, never `--self` or the parent's ID.

Verify with `bb thread show <reviewer-id> --json` that `.thread.archivedAt` is set and neither `.thread.status` nor `.thread.runtime.displayStatus` is `starting`, `active`, or `stopping`. Report any cleanup failure.
