Generate from a saved image, video, or 3D canvas node and its saved references. Use this when the output should attach to a node; use the standalone image, video, or 3D generation tools for a direct brief or approved image outside the canvas.

BEFORE CALLING

- Read `game_studio_canvas_context` and pass the exact returned board revision.
- Only saved inputs are submitted; unsaved UI drafts are excluded. Without a model override, the node's recipe selects the model.
- For Tripo P2, confirm the approved Front input with `approvedImagePath`. Connected Left, Back, and Right inputs supply further views. Video uses connected Start and End inputs as its frames.

UPSTREAM RUNS

- Set `upstream:true` to first run inputs that have no output, then their dependents and the target node. The server holds waiting nodes until their inputs land.
- A run stops at a step requiring an approved input, such as a Tripo front view or UV candidate, and reports a `gate`. Without upstream mode, an input without output fails the call immediately.

TRIPO PROCESSING

- Processing recipes use the `model` port. `tripo-smart-uv` generates a UV candidate: inspect its GLB in the model viewer's UV mode, choose its take, then run a connected `tripo-apply-uv` node.
- Only the applied output can feed `tripo-texture` or `tripo-pbr`. Source task and candidate operator identities come from saved jobs.
- Locally changed GLB bytes are snapshotted and imported as a new Tripo model. Regenerate modified candidates before application.

RETURNS AND NEXT STEP

- A started single-node run returns `{created,job}`. With upstream mode, returns `{jobs,waiting,gate?}`: started jobs, nodes waiting for inputs, and the approved-input gate it stopped at.
- Collect started jobs with `game_studio_generation`. Image, video, and 3D outputs attach as takes even if the node brief has changed; a `brief:true` result lands only while the saved brief is unchanged.
- Read `game_studio_canvas_context` again to check whether the chosen output is fresh for the current brief and inputs.

APPROVAL AND RETRIES

- Paid Google and Fal runs wait for the person's approval in the thread. The call blocks for up to ten minutes and returns the started job, or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add, for the request as it was asked: changing the prompt or settings under the same `requestId` asks again. A game approved in advance in the studio skips the form. BB-model runs never ask.
- Repeating a request with the same `requestId` and content answers the run on record without asking or spending again. Ids ending in `-b<n>` or `-retry-<n>` are the studio's own and are refused.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect it. Midjourney and Tripo are not available in the studio yet; say so instead of switching providers.
