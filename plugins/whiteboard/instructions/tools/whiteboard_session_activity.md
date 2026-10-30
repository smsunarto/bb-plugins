Claim a Whiteboard session for writing and show the user what you are working on. Begin a lease before your first write, pass its `leaseId` on every write in that scope, and end it when the work is finished.

- `scope` "document" (default) covers `whiteboard_session_edit`, `whiteboard_session_set_target`, `whiteboard_session_repin`, `whiteboard_session_rename`, `whiteboard_session_restore` and `whiteboard_session_delete`; "lenses" covers `whiteboard_session_lens_edit`. Each scope has its own lease, so one agent can write lenses while another writes the document.
- `begin` with a fresh UUID `leaseId`. While another agent's lease holds the scope, `begin` and writes without that lease are refused; wait for it to end or expire.
- `renew` during long reads or pauses; accepted writes that carry the `leaseId` renew it too. A lease expires after 3 minutes without either; then begin a new lease and reread the session before editing.
- `end` when finished. It saves no version, and repeating it is harmless.

`focus` (`description`, optional `targetId`, which names a lens in the lenses scope) shows the reader what you are working on; omit it to keep the current focus, or pass null to clear it.

Returns `workingCount`, `expiresAt`, and the live `scopes` and `focuses`. The panel shows an agent working while any lease is live and treats a session with content and no live lease as ready to read, so end your lease only when you are done.
