Read, resume, or stop waiting for an existing Game Studio generation job. Use this to collect a returned job or held run, or reconcile a confirmed failed dispatch; it does not submit a replacement job.

BEFORE CALLING
Use the job ID from the generation result, or the request ID of a returned held run. A status read on a request the studio has not started answers not found.

CHOOSING AN ACTION

- `status` reads the job, collects what the provider has finished, and catalogs successful outputs. Image and video outputs become takes on their source node without replacing its chosen output.
- `resume` only polls or downloads the existing provider task.
- `cancel` stops the studio waiting on the job; it does not cancel a paid provider task. For a run held until inputs arrive, it drops the waiting run.

RETURNS AND RECOVERY

- A run still held for its inputs has no job. Its request ID passed as `jobId` returns `{job:null,status:"waiting",run:{boardId,nodeId,requestedAt,error?}}`. The job is created when inputs land; there is nothing to resume yet.
- An uncertain job without a `taskId` was never confirmed by its provider; ask the person before submitting it again.
- An unknown job answers not found. Use a new request ID only for a new request.
