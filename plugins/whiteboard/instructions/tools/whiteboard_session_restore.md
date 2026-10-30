Roll a Whiteboard session back to a saved version. Its title, target and pins, PR identity, document and Diff-view lenses from that version are saved as a new version, so later versions stay in history. Find version numbers with `whiteboard_session_history` and read one first with `whiteboard_session_get` and `version`. Viewed progress and Home state are not rolled back. Works on the scratchpad too.

Pass a fresh UUID `commandId` and your document `leaseId` from `whiteboard_session_activity`. After a lost response, retry with the same `commandId` and identical input.
