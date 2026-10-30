Change a Whiteboard session's title. The new title is saved as a new version. The scratchpad's title cannot change.

Pass a fresh UUID `commandId` and your document `leaseId` from `whiteboard_session_activity`; while another agent holds that lease, the rename is refused. After a lost response, retry with the same `commandId` and identical input.
