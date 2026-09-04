# queue-worker

Runs recurring background jobs. A job is either an interval job (`every 15m`) or
a daily job (`daily at 09:00`) pinned to the calendar of the team that owns it.

`src/scheduler.ts` decides when each job runs next and how long a failed attempt
waits before its retry. `src/queue.ts` holds the jobs, `src/worker.ts` drains
whatever is due.

    bun src/worker.ts --once
