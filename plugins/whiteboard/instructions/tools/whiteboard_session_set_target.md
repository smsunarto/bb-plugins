Move an existing Whiteboard session to a new target, such as a PR's new head or a different base, keeping its document and component IDs. Use it to update a Whiteboard for newer code or after a create reports `headMoved`; use `whiteboard_session_repin` only to change the session's PR.

`target` takes the shapes `whiteboard_session_create` accepts and resolves to commit IDs when the command is accepted. Moving to another repository detaches the session's PR. Earlier versions keep their own source.

Returns `warnings` naming the source references and resources to recheck. Read the change since the old target, then fix them with `whiteboard_session_edit`.

Pass a fresh UUID `commandId` and your document `leaseId` from `whiteboard_session_activity`. After a lost response, retry with the same `commandId` and identical input. The scratchpad has no target.
