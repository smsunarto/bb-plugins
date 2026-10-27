Generate video from a standalone creative brief and optional start/end images. Started runs return a persisted asynchronous generation job.

CHOOSING BETWEEN TOOLS
Use this for a direct video request. For a saved canvas node with connected Start and End frames, use `game_studio_generate_canvas_media`.

INPUTS
The default model is Gemini Omni 1.1 Flash; Fal H3 Max is the supported alternative. Supply studio paths as `imagePath` and `endImagePath` when using start/end frames. Keep a stable `requestId` for this request.

RETURNS AND NEXT STEP
Poll `game_studio_generation` to collect the existing job and inspect the resulting video before selecting or importing it.

APPROVAL AND RETRIES

- Paid Google and Fal runs wait for the person's approval in the thread. The call blocks for up to ten minutes and returns the started job, or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add, for the request as it was asked: changing the prompt or settings under the same `requestId` asks again. A game approved in advance in the studio skips the form. BB-model runs never ask.
- Repeating a request with the same `requestId` and content answers the run on record without asking or spending again. Ids ending in `-b<n>` or `-retry-<n>` are the studio's own and are refused.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect it. Midjourney and Tripo are not available in the studio yet; say so instead of switching providers.
