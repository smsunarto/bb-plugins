---
"@smsunarto/bb-plugin-gtd-sidebar": patch
---

Stop painting every listed PR green. `/repos/:owner/:repo/pulls` omits
`mergeable_state` — GitHub computes it lazily and serves it only from the
numbered GET — so every PR matched off the open list parsed as `"unknown"`,
collapsed to attention `"none"`, and fell through to the open-PR green.
Conflicts, failing checks and branch protection were all invisible; only the
PRs that missed the list and took the numbered fallback ever turned red.

A listed open PR whose state the list cannot decide now buys it with a
numbered GET, deduped per PR and bounded by the existing per-tick cap. Draft,
auto-merge, merged and closed stay decidable from the list and spend nothing.
The webhook path had the same hole — `pull_request_review` and `issue_comment`
embed a shortened pull with no `mergeable_state`, and that value was published
straight to the sidebar — so it refetches too.

Conflicting PRs are now struck through as well as red, separating the one
state that needs a local rebase from the reds that need a re-run or a review.
