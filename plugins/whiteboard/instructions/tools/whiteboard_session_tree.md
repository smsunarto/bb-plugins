List the immediate entries of one directory in a Whiteboard session's target, to find files to read. `path` is a repository-relative directory (default: the root) and `side` defaults to "head"; a worktree target includes saved working files. `version` and `commit` select history as in `whiteboard_session_file`, and `repositoryId` and `head` together list any registered repository at explicit commits instead.

Returns entries with `path` and `kind` ("file" or "directory"). Pass a directory's `path` to go deeper.
