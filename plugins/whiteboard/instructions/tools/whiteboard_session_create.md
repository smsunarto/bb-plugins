Create a Whiteboard session for the code or change the user wants explained, and open it as a tab in the calling bb thread. Read `whiteboard_session_get_instructions` first, and register the checkout with `whiteboard_session_register_repository` to get its `repositoryId` (for a pull request, a checkout of the PR's GitHub repository).

SOURCES

- "target" (the usual choice): `title` and a `target`. A worktree target shows the checkout's saved working files and follows them; omitted `base` compares against its current commit. A commits target shows fixed commits; omitted `base` shows `head` with no diff, so pass the parent to show what a commit introduced. Revisions resolve to commit IDs when the command is accepted.
- "pull-request": `pullRequestUrl` alone. The PR is fetched into a registered checkout (`repositoryId` picks one), pinned at its head and GitHub's diff base, and titled from the PR unless you pass `title`.
- "pins": `title` and full commit `pins` from `whiteboard_session_resolve_pins`. Prefer "target".
- "scratchpad" always fails: Whiteboard makes each thread's scratchpad itself. Write to it with `sessionId: "scratchpad"`.

When a session for `pullRequestUrl` already exists, it is returned instead (`created: false`) without your title or target; read its `note`. If `headMoved`, move it with `whiteboard_session_set_target`; `ownedBy` means another agent holds its lease. Pass `reuseExisting: false` to create a separate session.

Returns `sessionId`, `version`, and `session` (its `whiteboard_session_list` row, with resolved commits and `repositoryPath`), so you can call `whiteboard_session_diff` next without another read. The session opens in the calling thread unless you pass `open: false`; `opened` and any `openError` report that, and a failed open does not undo the create. Then begin a document lease with `whiteboard_session_activity`.

Pass a fresh UUID `commandId`. After a lost response, retry with the same `commandId` and identical input to get the original result.
