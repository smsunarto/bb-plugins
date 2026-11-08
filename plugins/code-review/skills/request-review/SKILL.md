---
name: request-review
description: Request an independent review from the opposite provider (Claude or Codex) of current local agent-session work, including local committed changes or a session proposal, then fix accepted findings and verify.
argument-hint: "[local branch, session proposal, or focus]"
---

# Request Review

Use this skill for the current local agent session’s work: committed changes on its task branch or a proposal produced in the session. It does not review pull requests or orchestrate Slopcop reviews.

Stop at a verdict when the user says not to modify, such as read-only or report-only.

## Ask

This skill authorizes starting one review child with the commands below. The reviewer runs on the provider opposite this thread's, so a different model family checks the work:

- **This thread is Claude Code:** the reviewer is Codex `gpt-6.1-sol`.
- **This thread is any other provider:** the reviewer is Claude Code `claude-opus-5-5`.
- Both use reasoning level `high` and never fast mode. Codex gets `--service-tier default` so a remembered fast default does not apply.

For a change, commit it on this task's branch. Its head is the branch tip, and its base is `git merge-base <target remote branch> <branch>`, so a stack includes the branches below it. Never use `HEAD` or `gitbutler/workspace`; they mix in other work. For a design, the proposal goes in the prompt.

Give the reviewer a self-contained prompt: the intent, pinned base and head commits or proposal, any user-requested focus or evidence, and the shared brief added by `bb review prompt`. Replace the placeholders before running. Use a short topic and revision in `review_label`; the temporary file's unique name identifies this review round, including reruns of the same revision.

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

parent_provider=$(bb thread show "$BB_THREAD_ID" --json | jq -r '.thread.providerId')
if [ "$parent_provider" = claude-code ]; then
  set -- --provider codex --model gpt-6.1-sol --service-tier default; reviewer_name=Codex
else
  set -- --provider claude-code --model claude-opus-5-5; reviewer_name=Claude
fi

bb thread spawn --parent-self --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" \
  "$@" --reasoning-level high \
  --title "Review ($reviewer_name) — $review_label [$review_run]" --prompt-file "$review_prompt" --json
```

The spawn returns immediately with the new thread's `.id`; it does not wait for the review. Record the ID with its provider, target, and the printed review run. Use that ID for follow-up and cleanup, rather than looking up a thread by title. If the launch fails, report it rather than switching to another provider or model.

After the launch attempt, remove the prompt file with `rm -f '<printed-review-prompt-path>'`. Use the literal printed path in a later command; shell variables do not persist between tool calls.

BB sends the subthread's result to this parent automatically. Check the reviewer with `bb thread show <reviewer-id>` and read its answer with `bb thread output <reviewer-id>`.

## Judge and fix

Wait for the reviewer with `bb thread wait <reviewer-id> --timeout 9m`. Deny any permission request with `bb thread interactions deny <interaction-id> <reviewer-id>`; report a reviewer that remains stuck as missing. Check every finding against the code: act on real problems, and dismiss wrong or speculative ones with a reason. Fix accepted findings on this task's branch without touching other work, then rerun the relevant checks. For a design, correct the proposal instead. Report the reviewer, what you fixed, the verification results, and any findings you left with your reasons.

## Finish

After consuming the answer and finishing any follow-up, run `bb thread archive <reviewer-id>`, then `bb thread stop <reviewer-id>`. Do this for every child started by this review, including read-only reviews and failed or abandoned attempts once no longer needed. Use the recorded child IDs, never `--self` or the parent's ID.

Verify with `bb thread show <reviewer-id> --json` that `.thread.archivedAt` is set and neither `.thread.status` nor `.thread.runtime.displayStatus` is `starting`, `active`, or `stopping`. Report any cleanup failure.
