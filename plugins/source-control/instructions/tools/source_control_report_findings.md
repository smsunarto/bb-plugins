Report a review's findings to Source Control, where the person who asked for the review reads them beside the diff, checks the ones to act on, and comments on them. It is available only in review threads Source Control started with "Review with bb".

BEFORE CALLING
Finish the whole review first, then call exactly once with every finding, including an empty `findings` list when there are none.

INPUTS

- Name the file `path` at the reviewed head commit given in the review prompt. Use `line` for the last line of the finding's range and `startLine` for the first line of a multi-line range.
- Use `side: "RIGHT"` (default) with head-version numbering, or `"LEFT"` with base-version numbering for deleted code.
- Set `priority` from 0 to 3: P0 release blocker, P1 urgent, P2 ordinary defect, P3 low impact.
- Write `title` as an imperative sentence without a priority tag, and one short paragraph in `body` explaining the affected scenario and why the behavior is wrong.

RETURNS
A confirmation naming how many findings were saved and the Change they belong to. Then give your written reply as the review prompt asks.

SIDE EFFECTS
The findings are saved on the Change at the reviewed head, each with a stable id. A later call from this thread replaces the earlier report, so always submit the complete set together. A call from a thread that is not a Source Control review fails with an error and saves nothing.
