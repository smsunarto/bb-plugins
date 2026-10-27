Generate video from a standalone creative brief and optional start/end images. Started runs return a persisted asynchronous generation job.

CHOOSING BETWEEN TOOLS
Use this for a direct video request. For a saved canvas node with connected Start and End frames, use `game_studio_generate_canvas_media`.

INPUTS
The default model is Gemini Omni 1.1 Flash; Fal H3 Max and Midjourney are supported alternatives. Supply project-relative `imagePath` and `endImagePath` when using start/end frames. Keep a stable `requestId` for this request.

RETURNS AND NEXT STEP
Poll `game_studio_generation` to collect the existing job and inspect the resulting video before selecting or importing it.

APPROVAL AND RETRIES

- Paid Google, Midjourney, Fal, or Tripo runs wait for the person's approval. The immediate response is a waiting notice; a later message contains the started job or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add. A game approved in advance, or a previous approval for the same request ID with remaining budget, skips the form. BB-model runs never ask.
- Preserve `requestId` across retries. While approval is pending, wait for the later message; do not poll an unsubmitted request ID with `game_studio_generation`, because a missing-job status retires that ID.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect or reconcile it. After a confirmed failed dispatch, status can reconcile a missing host job before a new authorized submission. Never silently switch providers.
