After this thread's pull request merges, or after you push its commits to the
default branch, show the Landed card by writing a directive on its own line in
your final reply, outside code fences. List all of the thread's pull requests
and pushed commits, separated by spaces:

`::source-control-landed{prs="owner/repo#12 owner/repo#15" commits="owner/repo@<sha>"}`

No tool call is needed: when your turn ends bb checks the list with GitHub, and
the thread title gets 🚀 once all of it has landed. The card lets the human
settle the thread. Call source_control_share_landed instead when you need the
answer in this turn: whether everything landed, or why a list was refused.
