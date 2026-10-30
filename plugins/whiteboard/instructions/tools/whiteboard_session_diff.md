Read the change a Whiteboard session shows, before you write about it or group it into lenses.

- `format` "files" (default) lists changed files with `status`, `additions` and `deletions`.
- `format` "patch" returns plain-text patches with base and head line numbers on every line, ready for `review-source:` links. `context` sets context lines; files past `maxBytes` (default 40000, at most 500000) are listed with a `paths:[…]` hint to read next.
- `paths` narrows either format to files or directories.

By default the diff compares the session's base and head. `commit` selects one commit from `whiteboard_session_commits`, `version` reads a saved version's comparison, and `repositoryId`, `base` and `head` compare explicit commits of any registered repository instead. An unexpectedly empty diff usually means a wrong target; fix it with `whiteboard_session_set_target`.
