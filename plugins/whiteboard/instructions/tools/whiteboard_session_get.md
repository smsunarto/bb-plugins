Read a Whiteboard session's document: before editing an existing session, to find component IDs, and to check the whole document before you finish.

The default returns a text outline of every component with its ID and type, abbreviating prose and code. `targetId` returns one component in full; `full: true` returns all content in full. `format: "json"` returns data instead: an ID, type and label list by default, the raw component for `targetId`, or the whole stored version with `full`. `version` reads a saved version from `whiteboard_session_history`; the default is the current one.

Use `whiteboard_session_lens_get` for Diff-view lenses, and `whiteboard_session_source` or `whiteboard_session_file` for code.
