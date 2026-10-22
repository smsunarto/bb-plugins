Edit one document component. Read the Components section of `whiteboard_session_get_instructions` for fields and examples.

`insert` adds `content`: `parentId` nests it, `afterId` places it, and omitted placement appends. `update` patches a component's own fields; `null` removes an optional field. `replace` supplies the whole replacement component. `move` and `remove` use `targetId`.

The host returns durable component IDs and first-level child IDs. Use those IDs to edit a section's children or a diagram's units individually. Insert a new diagram whole; edit an existing diagram one node, edge, or step at a time. To add a `flow_node`, `flow_edge`, or `step`, insert it with `parentId` set to the diagram's ID. Connect each added flow node to an existing node with `link`. Removing a flow node removes its edges. Replace a call-stack block to change its frames.

Use a fresh UUID `commandId` for each operation and reuse it with identical input after a lost response. Pass the document `leaseId` from `whiteboard_session_activity`. Accepted edits save immediately. On the scratchpad, omitted placement inserts at the top; use `afterId` to order a multi-block explanation.
