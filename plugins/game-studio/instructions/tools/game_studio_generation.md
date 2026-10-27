Read, resume, or stop local waiting for an existing Game Studio generation job. Use this to collect a returned job or held run, or reconcile a confirmed failed dispatch; it does not submit a replacement job.

BEFORE CALLING
Use the job ID from the generation result or later started-job message, or the request ID of a returned held run. While paid approval is pending, wait for the later message instead: status on a missing host job retires the request ID and prevents that request from starting after approval.

CHOOSING AN ACTION

- `status` reads the job and catalogs successful outputs in `canvas/assets.json`. Image and video outputs become takes on their source node without replacing its chosen output.
- `resume` only polls or downloads the existing provider task.
- `cancel` stops local waiting; it does not cancel a paid provider task. For a run held until inputs arrive, it drops the waiting run.

RETURNS AND RECOVERY

- A run still held for its inputs has no job. Its request ID passed as `jobId` returns `{job:null,status:"waiting",run:{boardId,nodeId,requestedAt,error?}}`. The job is created when inputs land; there is nothing to resume yet.
- An uncertain job without a `taskId` requires provider-side reconciliation before any new request.
- If a failed dispatch has no host job, `status` safely retires the request ID and returns `{job:null,status:"not-submitted"}`, releasing the checkout reservation. Use a new request ID only after this confirmation and within authorized generation scope.
- Finish status collection before releasing a registered Rampage checkout. An unresolved dispatch holds the checkout until its saved job is accounted for.
