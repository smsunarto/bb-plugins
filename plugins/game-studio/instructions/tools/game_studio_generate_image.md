Generate images from a standalone creative brief and optional project-relative reference images. Started runs return a persisted asynchronous generation job.

CHOOSING BETWEEN TOOLS
Use this for a direct image request. To generate from a saved canvas node and its references, use `game_studio_generate_canvas_media` so the output attaches to that node.

BEFORE CALLING
Use a thread in the game's BB project and, when the game is connected to one, its checkout. Credentials live in Game Studio; provider CLI commands and keys are unnecessary.

INPUTS
The default Google Nano Banana 2.1 produces one image. Keep a stable `requestId` for this request and name reference `images` by their studio paths, as `game_studio_canvas_context` lists them.

RETURNS AND NEXT STEP
Collect and catalog the job's outputs with `game_studio_generation`, then inspect the candidates before selecting or importing one.

APPROVAL AND RETRIES

- Paid Google and Fal runs wait for the person's approval in the thread. The call blocks for up to ten minutes and returns the started job, or `{declined:true,reason,detail}`.
- Only `reason: "declined"` means the person refused. `"timeout"` means nobody answered within ten minutes; other reasons explain why the form closed.
- Approval covers the run's batch and any retries its node review may add, for the request as it was asked: changing the prompt or settings under the same `requestId` asks again. A game approved in advance in the studio skips the form. BB-model runs never ask.
- Repeating a request with the same `requestId` and content answers the run on record without asking or spending again. Ids ending in `-b<n>` or `-retry-<n>` are the studio's own and are refused.
- Once a job or held run is returned, use its job/request ID with `game_studio_generation` to collect it. Midjourney and Tripo are not available in the studio yet; say so instead of switching providers.
