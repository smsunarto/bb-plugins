Generate one geometry-only GLB with Tripo P2 from a visually approved front image. Use this for a standalone model request; use `game_studio_generate_canvas_media` for a saved model node and its connected views.

BEFORE CALLING
An approved image and an authorized paid-job scope are required. This tool does not support text-to-model, texturing, or rigging.

INPUTS
Pass the project-relative front image as `approvedImagePath`. Optional `views` supply left, back, and right images of the same subject. Keep a stable `requestId` for this request.

RETURNS AND NEXT STEP
A started run returns a persisted asynchronous job. Collect it with `game_studio_generation`, then review both the solid mesh and wireframe before Unity import.

APPROVAL AND RETRIES

- Paid Google, Midjourney, Fal, or Tripo runs wait for the person's approval. The immediate response is a waiting notice; a later message contains the started job or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add. A game approved in advance, or a previous approval for the same request ID with remaining budget, skips the form. BB-model runs never ask.
- Preserve `requestId` across retries. While approval is pending, wait for the later message; do not poll an unsubmitted request ID with `game_studio_generation`, because a missing-job status retires that ID.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect or reconcile it. After a confirmed failed dispatch, status can reconcile a missing host job before a new authorized submission. Never silently switch providers.
