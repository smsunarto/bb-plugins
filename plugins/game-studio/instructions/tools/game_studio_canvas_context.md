Read the saved Game Studio workflow before planning, editing, or generating assets. Returns bounded pages of boards, nodes, assets, or documents, with the exact revisions needed by edit and generation tools.

BEFORE CALLING
Reads need no particular thread; edits and generations do. The studio web app shows the same boards to the person.

INPUTS

- With `gameId` alone, get board summaries and revisions, the main document path, counts, and generation providers. Use a returned board ID as `boardId` to read its semantic nodes.
- `section` selects nodes (default), edges, assets, or documents. Edges require `boardId`; `nodeIds` selects up to 20 nodes and requires `boardId` and the nodes section.
- Follow `nextOffset` with `offset`; `limit` is 1–50. Layout and bulky histories are omitted, and `omittedDataKeys` names excluded node fields.
- To read a long prompt, take history, or other full node data field, pass `boardId` and `field:{nodeId,key,offset,limit}`. Use the nodes section without `nodeIds`; the returned `encoding` identifies text or JSON.

RETURNS AND NEXT STEP

- Node freshness is `missing` (no output), `fresh` (picked from the current brief and inputs), `stale` (brief or input changed), or `unknown` (import or a run without an input record).
- `pendingRun` identifies a run held until its inputs land, with its request ID and any error that prevented it from starting.
- Files live in Game Studio, not in the game's checkout: read and write them through the studio's tools, by the paths this read lists.
- Pass the returned `board.revision` exactly to `game_studio_canvas_edit` or `game_studio_generate_canvas_media`. Read again after changes.
