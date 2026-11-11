Show the human a Source Control card for committed work ready to look at: its branch or pull request, where it is on the way to merged, and its open review items, with a link to review it. Use `source_control_share_landed` instead once the work has merged.

INPUTS

- With no input, the card shows this thread's Change: the branch checked out in its checkout.
- Pass `targets` (2–25) to show several Changes as one card. Each is `{ "branch": "<name>" }` for a branch in this thread's checkout, or `{ "pullRequest": "<URL or owner/repo#123>" }` for a GitHub pull request. If a branch already has a pull request, either names the same Change; name each once. Order them as they should merge, the bottom of a stack first.

BEFORE CALLING
Commit the work first. A thread with no checkout or no branch checked out has no Change to show. With `targets`, every target must resolve: if one does not, nothing is shared and the error lists each failure; fix those and call again with the whole list.

RETURNS AND NEXT STEP
Returns a `::source-control` directive naming each Change and the head it is at now. Put it verbatim on its own line in your response, outside code fences. The card stays live: later commits, checks and review items show on it without calling again. Sharing publishes nothing, sends nothing and changes no review state.

A grouped card offers **Ship all**, which sends this thread one message listing every Change for you to ship, and **Merge all** once every one is a pull request ready to merge. Merge all is the human's: the card merges each pull request in order itself, pinned to the head it showed, and stops at the first that does not merge.
