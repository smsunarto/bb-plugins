Read an exact line range of code, to verify it before you cite it in a Whiteboard session. Reads the session's current target by default; `version` reads the source a saved version retained, and `commit` reads one commit from `whiteboard_session_commits`.

`source` is `{side, file, fromLine, toLine, pins?}` with a repository-relative `file` and 1-based inclusive lines; this differs from the `start`/`end` source shape in document components. `side` defaults to "head". `source.pins` (`{repositoryId, head, base?}`) reads at explicit commits of any registered repository instead, which the scratchpad needs because it has no pins of its own; a base-side read at explicit pins needs their `base`.

Returns the range with the `commit` it was read at and its `text`. Use `whiteboard_session_file` to read a whole file.
