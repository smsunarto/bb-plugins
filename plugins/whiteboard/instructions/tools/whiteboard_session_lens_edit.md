Write one Diff-view lens: a titled group of a Whiteboard session's changed lines, shown on the Diffs page beside the document, never in it. Follow `whiteboard_session_get_instructions({topic:"file-lenses"})` for how to group a change; use `whiteboard_session_edit` for the document.

Begin `whiteboard_session_activity` with `scope: "lenses"` and pass its `leaseId`. The document lease does not cover lenses.

- `insert` adds a lens with `title` and `targets`, after lens `afterId` or at the end.
- `update` replaces only the `title` or `targets` you pass on lens `targetId`; `remove` deletes it.
- `targets` select changed lines by repository-relative paths or globs (`kind: "files"`) or by source ranges (`kind: "ranges"`).

Write one lens per call; each appears on the Diffs page as you write it. Returns the lens ID as `targetId` and `uncategorized`: the changed lines no lens selects yet, by file. Keep adding lenses until it is empty or what remains is deliberate. If `warnings` says the uncategorized lines are unavailable, the lens was still saved.

Pass a fresh UUID `commandId`. After a lost response, retry with the same `commandId` and identical input. The scratchpad has no changes to lens.
