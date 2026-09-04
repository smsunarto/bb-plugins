import { formatClock, parseSchedule, scheduleToParts } from "./scheduler.ts";
import type { Job } from "./types.ts";

export type JobInput = {
  name: string;
  queue: string;
  schedule: string;
  /** Minutes east of UTC. Defaults to the operations calendar, which is UTC. */
  tzOffsetMinutes?: number;
  priority?: number;
  maxAttempts?: number;
};

const jobs = new Map<string, Job>();
let sequence = 0;

export function createJob(input: JobInput): Job {
  const schedule = parseSchedule(input.schedule);
  if (schedule === null) throw new Error(`unreadable schedule "${input.schedule}"`);

  sequence += 1;
  const parts = scheduleToParts(schedule);
  return {
    id: `job-${String(sequence).padStart(4, "0")}`,
    name: input.name,
    queue: input.queue,
    hour: parts.hour,
    minute: parts.minute,
    tzOffsetMinutes: input.tzOffsetMinutes ?? 0,
    intervalMinutes: parts.intervalMinutes,
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    lastRunAt: null,
    scheduledFor: null,
    state: "idle",
  };
}

export function add(job: Job): Job {
  jobs.set(job.id, job);
  return job;
}

export function replace(job: Job): void {
  jobs.set(job.id, job);
}

export function all(): Job[] {
  return [...jobs.values()];
}

export function byQueue(queue: string): Job[] {
  return all().filter((job) => job.queue === queue);
}

export function clear(): void {
  jobs.clear();
}

export function formatOffset(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(tzOffsetMinutes);
  return `UTC${sign}${formatClock(Math.floor(magnitude / 60), magnitude % 60)}`;
}

export function describeJob(job: Job): string {
  const when =
    job.intervalMinutes === null
      ? `${formatClock(job.hour, job.minute)} ${formatOffset(job.tzOffsetMinutes)}`
      : `every ${job.intervalMinutes}m`;
  return `${job.id} ${job.name} [${job.queue}] ${when}`;
}
