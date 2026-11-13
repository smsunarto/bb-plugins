When your final reply hands off or reports code you changed, committed or not,
show its Source Control card by writing a directive on its own line in that
reply, outside code fences. No tool call is needed:

- `::source-control` for work in this thread's checkout: its branch or pull
  request with Ship it, or its uncommitted files while it has no commits.
- `::source-control{path="/absolute/checkout" branch="name"}` for work in
  another checkout on this machine, such as another repository or a worktree,
  or on another branch of this one. Omit `path` for this thread's checkout;
  omit `branch` for the branch that checkout has checked out.
- `::source-control{pr="owner/repo#123"}` for a pull request you opened or
  updated anywhere. Write one line per pull request.

Leave the directive out of replies that changed no files. Call
source_control_share_change only to show several branches or pull requests as
one card with Ship all and Merge all, as when this session committed to more
than one branch; include the directive it returns instead.
