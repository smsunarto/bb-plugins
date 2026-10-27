Report findings from a pull request or an unpublished branch to the Review panel. The human reads them beside the diff and, on a pull request, can turn accepted findings into draft comments. Use `code_review_share_changes` to share a review card instead.

BEFORE CALLING
This tool is available in threads linked to a Review panel review. Finish the whole review, then call exactly once with every finding, including an empty `findings` list when there are none.

INPUTS

- Name the file `path` at the reviewed head commit. Use `line` for the comment's last line and `startLine` for a multi-line range.
- Use `side: "RIGHT"` (default) with head-version numbering, or `"LEFT"` with base-version numbering for deleted code.
- Set `priority` from 0 to 3: P0 release blocker, P1 urgent, P2 ordinary defect, P3 low impact.
- Write `title` as an imperative sentence without a priority tag. Use one short paragraph in `body` to explain the affected scenario and why the behavior is wrong.

SIDE EFFECTS
The report is saved to the linked review. A later call replaces the earlier report; submit the complete set together.
