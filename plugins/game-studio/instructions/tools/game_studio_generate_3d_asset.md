Generate one geometry-only GLB with Tripo P2 from a visually approved front image. Use this for a standalone model request; use `game_studio_generate_canvas_media` for a saved model node and its connected views.

BEFORE CALLING
An approved image is required, and the studio must report Tripo as configured in `game_studio_canvas_context`. The web studio does not run Tripo yet, so expect it to refuse; say so instead of switching providers. This tool does not support text-to-model, texturing, or rigging.

INPUTS
Pass the front image's studio path as `approvedImagePath`. Optional `views` supply left, back, and right images of the same subject. Keep a stable `requestId` for this request.

RETURNS AND NEXT STEP
A started run returns a persisted asynchronous job. Collect it with `game_studio_generation`, then review both the solid mesh and wireframe before Unity import.

APPROVAL AND RETRIES

- Paid Google and Fal runs wait for the person's approval in the thread. The call blocks for up to ten minutes and returns the started job, or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add, for the request as it was asked: changing the prompt or settings under the same `requestId` asks again. A game approved in advance in the studio skips the form. BB-model runs never ask.
- Repeating a request with the same `requestId` and content answers the run on record without asking or spending again. Ids ending in `-b<n>` or `-retry-<n>` are the studio's own and are refused.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect it. Midjourney and Tripo are not available in the studio yet; say so instead of switching providers.
