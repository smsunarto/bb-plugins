Replace a Whiteboard session's commit pins or PR identity, keeping its document and component IDs. Use it to attach, replace or detach the session's PR: omitted `pullRequestUrl` keeps it within the same repository and detaches it when the repository changes, a URL replaces it, and null detaches it. To move a session to newer code, prefer `whiteboard_session_set_target`.

`pins` must be full commit IDs from `whiteboard_session_resolve_pins`; the target becomes those commits. Returns `warnings` for source ranges and resources to recheck; fix them with `whiteboard_session_edit`. Earlier pins stay in `whiteboard_session_history`.

Pass a fresh UUID `commandId` and your document `leaseId` from `whiteboard_session_activity`. After a lost response, retry with the same `commandId` and identical input. The scratchpad has no pins.
