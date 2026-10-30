Permanently delete a Whiteboard session and all its versions. Delete only when the user asks; to hide a session from Whiteboard Home instead, use `whiteboard_session_attention` with action "dismiss". The scratchpad cannot be deleted.

Pass a fresh UUID `commandId` and your document `leaseId` from `whiteboard_session_activity`; while another agent holds that lease, the delete is refused. Deletion cannot be undone. A retry after a lost response fails with a not-found error saying the command's session was deleted, which confirms the deletion.
