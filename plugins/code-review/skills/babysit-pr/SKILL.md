---
name: babysit-pr
description: Monitor a pull request through review and CI. Use when the user asks to monitor, watch, or babysit a PR.
---

# Babysit PR

Many repos have AI review bots. They're helpful, even if they are not always
right.

## Waiting

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher
per PR: `code_review_watch_pr`. Every watcher on a GitHub account shares one
rate limit.

Handle the existing checks and comments first. Then call
`code_review_watch_pr` and end your turn. bb wakes you with a message when a
check fails, all checks finish on the head, someone comments or reviews, the
branch conflicts or falls behind, or the PR merges or closes. The watch
continues across pushes, so you do not need to call it again after you push.

- **Only the thread that owns the PR watches it.** If you are a delegated
  child thread (a reviewer, or any other subthread working for a parent),
  never call `code_review_watch_pr`. The parent owns the PR. Do not watch PRs
  you are not working on.
- **A wake is news, not a merge decision.** Check the merge gate yourself.
- **Unwatch when you hand off.** A watched thread keeps waking on new events.
  When you stop (ready, blocked, or asking the user a question), call
  `code_review_watch_pr` with `stop: true` first. A merge or close ends the
  watch on its own.
- **"Stopped watching after failed reads"** means GitHub stayed unreadable.
  Run `gh api rate_limit --jq .resources.graphql` before you watch again. If `remaining` is near 0, wait for `reset` with one background
  command, then watch again. Never watch again in a tight loop.

When an event needs no action, end your turn without a message. Never post or
say "still waiting".

## GitHub rate limits

`gh pr create`, `gh pr view`, and `gh pr checks` use GraphQL. When GraphQL is
used up, the REST limit is separate and usually still has room. Use
`gh api repos/<owner>/<repo>/pulls/<n>` to read a PR, and
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs` for checks.

## Reviews

Only act on checks and comments newer than the latest push. Verify every bot
finding against the source before changing code. Fix real findings and CI
failures, distinguish repository failures from infrastructure flakes, and reply
with a written reason when dismissing false positives.

If the repo has `.macroscope/check-run-agents/*.md`, read those rules before you
reply to a Macroscope finding. Its findings cite them.

CodeRabbit is advisory. Treat its findings like any other finding, but never
wait for it and never hold a merge for it.

If a review bot leaves feedback you believe is not worth addressing, reply with
a written reason and resolve the comment.

Screenshots and videos help as well, when you have a way to upload them.

Keep the PR at the size the user's goal needs. Review loops tend to grow a
PR one cheap-looking fix at a time. Fix real bugs in the intended case.
Decline the rest with a written reason, and list them as follow-ups:
unneeded tests, guards for edge cases that do not matter, extra integration
or compatibility, and small performance costs. Prefer the fix that deletes or
narrows code.

## Base branch and merging

Keep an eye on changes to `main` and rebase when needed. The watch reports
when the PR becomes BEHIND or DIRTY. It does not report base commits that touch
this PR's files, so check for those yourself before you call the PR ready.
If an overlapping PR makes this one obsolete, stop watching, report it to the
user, and ask before closing the PR unless closure was explicitly authorized.

If nothing has changed, stay quiet rather than posting filler comments. Stop
when the merge gate passes on the latest head. Merge only when the user
explicitly requested it; otherwise report that the PR is ready. Right before a
merge, run `git fetch` and check the PR again. Never merge when it is BEHIND or
DIRTY, or when base commits that landed after the last green run touch this
PR's files. Rebase, push, and wait for green again.
