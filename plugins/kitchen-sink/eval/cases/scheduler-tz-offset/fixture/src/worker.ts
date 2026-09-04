import { add, all, clear, createJob, describeJob, replace } from "./queue.ts";
import {
  applyOutcome,
  dueJobs,
  humanDelay,
  scheduleAll,
  summarizeQueue,
  timeUntil,
} from "./scheduler.ts";
import type { Job, JobOutcome } from "./types.ts";

export type JobRunner = (job: Job) => JobOutcome;

export function seedDefaultJobs(): Job[] {
  clear();
  return [
    add(
      createJob({
        name: "billing-invoice-drop",
        queue: "billing",
        schedule: "daily at 09:00",
        tzOffsetMinutes: 540,
      }),
    ),
    add(
      createJob({
        name: "warehouse-count",
        queue: "ops",
        schedule: "daily at 06:30",
        tzOffsetMinutes: -480,
      }),
    ),
    add(
      createJob({
        name: "eu-payout-file",
        queue: "billing",
        schedule: "daily at 17:15",
        tzOffsetMinutes: 60,
        priority: 5,
      }),
    ),
    add(createJob({ name: "session-sweep", queue: "ops", schedule: "every 15m" })),
    add(
      createJob({
        name: "usage-rollup",
        queue: "reports",
        schedule: "every 2 hours",
        maxAttempts: 5,
      }),
    ),
  ];
}

export function tick(runner: JobRunner, now: number): Job[] {
  for (const job of scheduleAll(all(), now)) replace(job);

  const ran: Job[] = [];
  for (const job of dueJobs(all(), now)) {
    replace({ ...job, state: "running" });
    const outcome = runner(job);
    const settled = applyOutcome(job, outcome, now);
    replace(settled);
    ran.push(settled);
  }
  return ran;
}

export function pendingReport(now: number): string {
  return all()
    .map((job) => {
      const wait = timeUntil(job, now);
      const when = wait === null ? "unscheduled" : humanDelay(wait);
      return `${describeJob(job)} -> ${when}`;
    })
    .join("\n");
}

if (import.meta.main) {
  seedDefaultJobs();
  const now = Date.now();
  for (const job of scheduleAll(all(), now)) replace(job);
  console.log(pendingReport(now));
  if (process.argv.includes("--once")) {
    tick(() => ({ ok: true }), now);
    console.log(summarizeQueue(all()));
  }
}
