# Code Review

Review GitHub pull requests without leaving bb: an inbox of what waits on
you, each pull request's description, diff, and checks, draft comments on
any line, a one-click bb review, and **Submit review** to post it all.

It is a bb take on [Codex Code Review](https://learn.chatgpt.com/docs/code-review),
for GitHub only. Open **Code Review** in the sidebar.

## Nothing posts until you submit

Draft comments are comments on your **pending review** on GitHub, the same
one github.com keeps while you review there. Only you see them, on both
sides, and **Submit review** posts every draft at once as a comment, an
approval, or a change request. **Discard drafts** deletes the pending review.
There is no local copy of a draft to fall out of step with GitHub.

## Inbox

- **Assigned to me**: a review requested from you directly, or a pull
  request assigned to you.
- **My team**: a review requested from one of your teams, and not from you.
- **Authored by me**: your open pull requests. Your own pull requests appear
  only here, even when you assigned yourself.
- **Pinned**: any pull request you pin, open or not, in pin order. A pinned
  pull request that was deleted, or that you lost access to, drops out.

The sidebar badge counts the pull requests in the first two sections that
you have not reviewed yet.

## A pull request

- **Summary**: the description, labels, reviewers and where each stands,
  checks, review findings, the bb threads started for it, the open pull
  requests stacked under and on top of it, and its activity.
- **Changes**: every file's diff with the review threads on it, your drafts,
  and review findings inline. Write a draft on any line or range, reply, edit
  or delete drafts, and mark files viewed, which github.com shows too.
  Generated files (lockfiles, build output, and anything the repository's
  `.gitattributes` marks `linguist-generated`) sort last and start folded.
- **Checks**: check runs and commit statuses on the head commit, failures
  first. **Fix** opens a new-thread composer prefilled with the failing
  checks and the end of each failed GitHub Actions job's log.

## Review with bb

**Review with bb** starts a thread on bb's default agent, at high reasoning,
that reviews the pull request's head commit read-only: it does not edit,
commit, push, or comment on GitHub. It reports every finding, P0 to P3,
back to the panel with the `code_review_report_findings` tool, and the
findings show beside the diff. A finding on an older head commit is marked
stale. Asking again while a review of the same commit runs opens that review.

The thread runs in a ready bb environment already on the pull request's
branch when there is one, and then leaves its working tree alone. Otherwise
it gets a fresh worktree on the project's default machine. **Review
instructions** sets what every later review should pay attention to.

The prompt lives in [`instructions/review-with-bb.md`](instructions/review-with-bb.md),
adapted from Codex's own review agent, and the Prompt Editor plugin can edit
it.

## Requirements

- The GitHub CLI (`gh`) installed and signed in (`gh auth login`) on the
  machine running the bb server. Every GitHub call goes through it, so the
  plugin stores no token.
- For reviews and fixes: the repository added as a bb project whose git
  remote is the GitHub repository.

## What it stores

In bb's plugin storage: your pins, your review instructions, and which bb
threads were started for which pull request, with each review's
findings. Everything else is read from GitHub when you open it.

## Development

```sh
bun install
bun run --filter '@smsunarto/bb-plugin-code-review' test
bun run --filter '@smsunarto/bb-plugin-code-review' typecheck
bun run --filter '@smsunarto/bb-plugin-code-review' check
```

The server's GitHub queries are tested against responses recorded from real
pull requests in `test/fixtures/`. Write paths are tested against a fake
`gh` (`test/fake-gh.ts`) that records the exact mutations sent.

Run the tests through the `test` script, not a bare `bun test`. The script
turns off JavaScriptCore's FTL JIT (`BUN_JSC_useFTLJIT=0`). Under Bun 1.4.2,
the app tests that open modals, run in one process, hang inside jsdom's
`getComputedStyle` and grow without bound until the machine runs out of
memory. Drop the flag once a Bun upgrade passes the full suite without it.

## License

[MIT](LICENSE)
