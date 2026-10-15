## Request progress

The submitted request includes `request` with `id`, `action`, and `createdAt`,
and `requestPath` naming its own `canvas/requests/<id>.json` file. Track only
requests actually sent to this thread. Preparing a composer draft is not a job.

Read that file before updating it. Preserve its `id`, `action`, `threadId`, and
numeric `createdAt`. If you begin before Studio has initialized it, create it
with the submitted descriptor and this BB thread's real id. Write complete JSON
atomically with these fields:

```json
{
  "id": "the-submitted-request-id",
  "action": "the-submitted-action",
  "createdAt": 0,
  "threadId": "this-BB-thread-id",
  "status": "running",
  "detail": "A short description of the current step"
}
```

Use `running` while doing the work, `done` only after the requested result is
verified, `failed` for a confirmed failure, and `uncertain` when interrupted or
unable to establish the result. Studio's initial `queued` status means the
request was accepted by BB. An idle thread or a finished agent turn does not
prove the request succeeded. Do not mark other requests complete. Keep `detail`
under 2,000 characters and keep credentials out of progress files. The Unity tab
shows the five newest valid request files, within a 1,000-file read limit.

Never fabricate progress or successful verification. A lost Pipeline response,
unknown job outcome, or uncertain Editor claim requires `uncertain` status until
the managed Editor workflow reconciles the actual result. Do not repeat an
operation while its outcome is unknown.
