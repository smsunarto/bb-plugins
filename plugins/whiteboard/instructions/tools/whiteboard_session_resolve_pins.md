Resolve a base and a head revision (a branch, tag or abbreviated commit) in a registered repository to full commit IDs. Use the result where Whiteboard rejects moving names: source "pins" in `whiteboard_session_create`, `whiteboard_session_repin`, a map upload's `pins`, and `pins` on source references in the document. `whiteboard_session_create` and `whiteboard_session_set_target` resolve a `target` themselves.

Returns `repositoryId`, `base` and `head`. A revision missing from the local checkout fails; fetch it there first.
