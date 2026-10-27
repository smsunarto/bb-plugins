Generate images from a standalone creative brief and optional project-relative reference images. Started runs return a persisted asynchronous generation job.

CHOOSING BETWEEN TOOLS
Use this for a direct image request. To generate from a saved canvas node and its references, use `game_studio_generate_canvas_media` so the output attaches to that node.

BEFORE CALLING
Use an authorized generation scope. Credentials are server-managed; provider CLI commands and keys are unnecessary.

INPUTS
The default Google Nano Banana 2.1 produces one image; Midjourney produces four candidates. Keep a stable `requestId` for this request and use project-relative paths for reference `images`.

RETURNS AND NEXT STEP
Collect and catalog the job's outputs with `game_studio_generation`, then inspect the candidates before selecting or importing one.

APPROVAL AND RETRIES

- Paid Google, Midjourney, Fal, or Tripo runs wait for the person's approval. The immediate response is a waiting notice; a later message contains the started job or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add. A game approved in advance, or a previous approval for the same request ID with remaining budget, skips the form. BB-model runs never ask.
- Preserve `requestId` across retries. While approval is pending, wait for the later message; do not poll an unsubmitted request ID with `game_studio_generation`, because a missing-job status retires that ID.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect or reconcile it. After a confirmed failed dispatch, status can reconcile a missing host job before a new authorized submission. Never silently switch providers.
