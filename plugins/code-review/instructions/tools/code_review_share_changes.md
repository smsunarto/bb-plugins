Create a clickable Review card when committed changes are ready for the human to inspect. Use `code_review_report_findings` instead to deliver an agent review's findings to the panel, and `code_review_share_landed` once the work has merged or reached the default branch.

INPUTS

- Pass `target` for one change, or `targets` for 2–25 distinct branches and/or PRs. Use `targets` to show one grouped card with a single **Ship all** button. Supply exactly one of these fields. Every target must resolve; fix a failed target and retry the whole call.

- For an unpublished local change, pass the task's committed GitButler branch name. It defaults to the calling thread's ready checkout and host. Supply `path` for another checkout on that host, or `hostId` and `path` for another machine. With `hostId` alone, it searches that host's checkouts and requires a unique match. If the thread has no ready checkout, supply `hostId` and `path`.
- For a GitHub pull request, pass its URL or `owner/repo#123`, with an optional GitHub `account`. If a local branch already has a pull request, use the PR target.

RETURNS AND NEXT STEP
Returns a `::code-review` directive. Put it verbatim on its own line in the assistant response, outside code fences. The card opens Changes and shows per-file review progress. A grouped card keeps each review link and sends one shipping request to this thread listing every target. It does not publish directly; the agent refreshes revisions and checks readiness before shipping.

REVIEW STATE
Local review marks belong to the exact base and head; new commits start unchecked. The card follows the branch’s current changes. Checkboxes record human review progress; they do not submit a GitHub review, merge, or publish anything.
