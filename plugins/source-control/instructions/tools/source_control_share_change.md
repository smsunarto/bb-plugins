Show the human a Source Control card for branches or pull requests you name: where each is on the way to merged and its open review items, with a link to review it.

CHOOSING BETWEEN A HAND-WRITTEN DIRECTIVE AND THIS TOOL

- This thread's own work, committed or not: write `::source-control` on its own line in your reply and call nothing. That card follows the thread's branch, pull request and uncommitted files as they change.
- One pull request, in any repository or checkout: write `::source-control{pr="owner/repo#123"}` on its own line and call nothing.
- Call this tool to show several Changes as one card, as when this session committed to more than one branch, or to pin a card to the head you are handing off.
- Once the work has merged, use `source_control_share_landed`.

INPUTS

- With no input, the card shows this thread's Change at its current head: the branch its checkout has checked out, or in a GitButler workspace the branch this thread's `but` commands last committed to.
- Pass `targets` (1–25) to name the Changes yourself. Each is `{ "branch": "<name>" }` for a branch in this thread's checkout, or `{ "pullRequest": "<URL or owner/repo#123>" }` for a GitHub pull request in any repository. One target returns a single card; two or more return one grouped card. If a branch already has a pull request, either names the same Change; name each once. Order them as they should merge, the bottom of a stack first.

BEFORE CALLING
Commit the work first: this tool shows branches and pull requests. A branch in another checkout is reachable only through its pull request. A thread with no checkout, or no branch of its own yet, has no Change for the no-input form; write `::source-control` for its uncommitted work. With `targets`, every target must resolve: if one does not, nothing is shared and the error lists each failure; fix those and call again with the whole list.

RETURNS AND NEXT STEP
Returns a `::source-control` directive naming each Change and the head it is at now. Put it verbatim on its own line in your response, outside code fences. The card stays live: later commits, checks and review items show on it without calling again. Sharing publishes nothing, sends nothing and changes no review state.

A grouped card offers **Ship all**, which sends this thread one message listing every Change for you to ship, and **Merge all** once every one is a pull request ready to merge. Merge all is the human's: the card merges each pull request in order itself, pinned to the head it showed, and stops at the first that does not merge.
