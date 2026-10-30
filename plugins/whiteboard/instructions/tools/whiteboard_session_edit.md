Write one component of a Whiteboard session's document: add, change, move or remove a section, prose block, code peek or diagram. Use `whiteboard_session_lens_edit` for Diff-view lenses; this tool edits the document itself.

BEFORE CALLING

- Read `whiteboard_session_get_instructions` (default topic) for component fields and examples.
- Begin `whiteboard_session_activity` with a fresh UUID `leaseId` and document scope, then pass that same `leaseId` on every edit.
- Cite only ranges you have read with `whiteboard_session_source` or `whiteboard_session_file`. An edit is rejected when a new source range does not exist at its pins or a code peek's range is blank.

EDIT OPERATIONS

- `insert` adds `content`; `parentId` nests it, `afterId` places it, and omitted placement appends. On the scratchpad, omitted placement inserts at the top: use `afterId` to order multiple blocks.
- `update` patches the target's own fields through `changes`; `null` removes an optional field. `replace` supplies a whole replacement block. `move` and `remove` address `targetId`.
- Insert a new diagram whole. Edit an existing diagram one node, edge, or step at a time. Insert a `flow_node`, `flow_edge`, or `step` with the diagram's ID as `parentId`; connect each added flow node to an existing node with `link`. Removing a flow node removes its edges.
- Replace a call-stack block to change its frames.

RETURNS AND RECOVERY
Accepted edits save immediately as a new version and return the component's durable ID as `targetId`, plus first-level child IDs in `children` for an insert or replace. Use those IDs for later edits to a section's children or a diagram's units, and repair any references named in `warnings`. Use a fresh UUID `commandId` for each operation; after a lost response, retry with the same ID and identical input. If an edit is refused because the session changed or your lease ended, reread it with `whiteboard_session_get`, begin a new lease if yours ended, and retry.
