Edit a saved Game Studio workflow atomically. Use this to change node briefs, settings, or connections; use `game_studio_generate_canvas_media` to run an unchanged saved node.

BEFORE CALLING

- Read `game_studio_canvas_context` and pass its exact `board.revision` as `revision`.
- Use a thread in the game's BB project and, when the game is connected to one, its checkout. Submit one coherent batch per change so the person can review and undo it together.

EDIT OPERATIONS

- Submit 1–100 operations. Add nodes before connecting them in the same batch. New nodes use the canvas UI's defaults.
- `update_node` merges data keys, preserving outputs, histories, and untouched layout. Generation history keys cannot be overwritten. Configure node `review` with `{enabled:true,retries:0,criteria:"..."}` and `judge` with `{enabled:true,criteria:"..."}` in data.
- Use `connect` and `disconnect` for node wires; `connect_asset` and `remove_input` for library or wireless inputs. Connections update both the visible wire and model input, validating port type and capacity.
- Video ports are `start` and `end`; Tripo P2 views are `front`, `left`, `back`, and `right`. Tripo processing recipes use the `model` port. Smart UV uses `type:"model-3d"` with `data.recipe:"tripo-smart-uv"`, followed by `tripo-apply-uv`; connect the chosen candidate to Apply UV before texture/PBR.
- Select an uploaded model with `assetId` on a model-3d node. Library `images` and `references` on a new node must name existing image assets.
- `remove_input` addresses the exact saved array index for images or references, or selects `promptSource`. It removes the wire once its last corresponding input is removed. Removing a node cleans its incident wires and references, including `promptSource`.
- Adds use estimated placement. `move_node` positions last until the next canvas open, which automatically arranges measured cards. Use the canvas UI's Arrange button for measured layout.

RUNNING WITH AN EDIT

- `dryRun:true` validates the supplied revision without writing.
- Add `run:{nodeId,requestId}` to run a node of the edited board and upstream inputs that lack outputs after saving, as with `game_studio_generate_canvas_media` and `upstream:true`.
- A paid run asks for approval before anything is saved. The call waits up to ten minutes for the person's answer and returns the saved edit and run, or `{declined:true,saved:false,reason}` with the board unchanged.
- Without `run`, editing does not generate media or spend credits.

RETURNS AND RECOVERY

- A saved edit returns `editId`, which the studio can use to put the change back while it is the board's latest content.
- The result carries `run:{jobs,waiting,gate?}`; a dry run returns `run:{planned}`. Collect started jobs with `game_studio_generation`.
- If saving succeeds but the run cannot start, the result still describes the saved edit, with `run:{error}`. Use that saved revision for the next call.
- A stale revision is rejected: reread the affected nodes, merge the intended change, and retry with the new revision.
