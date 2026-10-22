# Group changes into Diff lenses

Input: a Whiteboard session ID and its target. Lenses partition changed lines in the Diff view; they live beside the document.

1. Begin `whiteboard_session_activity` with a fresh `leaseId` and `scope: "lenses"`. Pass it to each `whiteboard_session_lens_edit`, renew during long reads, and end it when grouping is complete.
2. Call `whiteboard_session_lens_get`. Its `uncategorized` entries are the changed lines still to group; before the first lens, they cover the whole change. Keep existing lenses that still describe their selected changes.
3. Group non-implementation changes first: tests, docs, generated files and lockfiles, config and build files, fixtures and snapshots, renames, and formatting.
4. Group implementation changes by the part of the design each serves, in the order a reader should follow it. Keep each lens small enough to read in one sitting. Split a file across lenses only when it contains unrelated changes.
5. Write one lens per `whiteboard_session_lens_edit`. Use the returned `uncategorized` entries to choose the next group. Read a relevant patch with `whiteboard_session_diff({sessionId, format: "patch", paths: [...]})` when the file listing is insufficient.
6. Call `whiteboard_session_lens_get` again. Finish when `uncategorized` is empty and every lens accurately describes the changes it selects. If the diff is unexpectedly empty, report the target mismatch to the document author before ending your lease.
