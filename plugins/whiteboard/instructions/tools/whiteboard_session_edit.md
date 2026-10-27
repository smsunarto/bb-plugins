Edit one component in a Whiteboard document. Use `whiteboard_session_lens_edit` for Diff-view lenses; this tool edits the document itself.

BEFORE CALLING

- Read the Components section of `whiteboard_session_get_instructions` for fields and examples.
- Begin `whiteboard_session_activity` with a fresh UUID `leaseId` and document scope, then pass that same `leaseId` on edits.

EDIT OPERATIONS

- `insert` adds `content`; `parentId` nests it, `afterId` places it, and omitted placement appends. On the scratchpad, omitted placement inserts at the top: use `afterId` to order multiple blocks.
- `update` patches a component's own fields; `null` removes an optional field. `replace` supplies the whole replacement component. `move` and `remove` address `targetId`.
- Insert a new diagram whole. Edit an existing diagram one node, edge, or step at a time. Insert a `flow_node`, `flow_edge`, or `step` with the diagram's ID as `parentId`; connect each added flow node to an existing node with `link`. Removing a flow node removes its edges.
- Replace a call-stack block to change its frames.

RETURNS AND RECOVERY
Accepted edits save immediately and return durable component IDs and first-level child IDs. Use those IDs for subsequent edits to a section's children or a diagram's units. Use a fresh UUID `commandId` for each operation; after a lost response, retry with the same ID and identical input.
