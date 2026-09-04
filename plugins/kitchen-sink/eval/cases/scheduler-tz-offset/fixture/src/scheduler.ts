import type { Job, JobOutcome, QueueSummary, Schedule } from "./types.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BASE_BACKOFF_MS = 30 * 1_000;
const MAX_BACKOFF_MS = 30 * MINUTE_MS;

const INTERVAL_PATTERN = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/;
const DAILY_PATTERN = /^daily\s+at\s+(\d{1,2}):(\d{2})$/;

export function parseSchedule(spec: string): Schedule | null {
  const trimmed = spec.trim().toLowerCase();

  const interval = INTERVAL_PATTERN.exec(trimmed);
  if (interval !== null) {
    const amount = Number(interval[1]);
    const unit = interval[2] ?? "m";
    const intervalMinutes = unit.startsWith("h") ? amount * 60 : amount;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) return null;
    return { kind: "interval", intervalMinutes };
  }

  const daily = DAILY_PATTERN.exec(trimmed);
  if (daily !== null) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { kind: "daily", hour, minute };
  }

  return null;
}

/** Flattens a parsed schedule onto the fields a job carries. */
export function scheduleToParts(schedule: Schedule): {
  hour: number;
  minute: number;
  intervalMinutes: number | null;
} {
  if (schedule.kind === "interval") {
    return { hour: 0, minute: 0, intervalMinutes: schedule.intervalMinutes };
  }
  return { hour: schedule.hour, minute: schedule.minute, intervalMinutes: null };
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function humanDelay(ms: number): string {
  if (ms <= 0) return "now";
  const totalSeconds = Math.round(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (hours === 0 && seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function describeSchedule(job: Job): string {
  if (job.intervalMinutes !== null) {
    if (job.intervalMinutes % 60 === 0) {
      const hours = job.intervalMinutes / 60;
      return hours === 1 ? "hourly" : `every ${hours} hours`;
    }
    return `every ${job.intervalMinutes}m`;
  }
  return `daily at ${formatClock(job.hour, job.minute)}`;
}

export function startOfDay(at: number): number {
  const moment = new Date(at);
  return Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), moment.getUTCDate());
}

/**
 * Interval jobs keep their original cadence across a slow run, so the step
 * walks forward from the last run rather than from the current clock.
 */
export function nextRunAt(job: Job, from: number): number {
  if (job.intervalMinutes !== null && job.intervalMinutes > 0) {
    const step = job.intervalMinutes * MINUTE_MS;
    const anchor = job.lastRunAt ?? from;
    const steps = Math.max(1, Math.ceil((from - anchor + 1) / step));
    return anchor + steps * step;
  }

  const target = startOfDay(from) + job.hour * 60 * MINUTE_MS + job.minute * MINUTE_MS;
  return target > from ? target : target + DAY_MS;
}

export function upcomingRuns(job: Job, from: number, count: number): number[] {
  const runs: number[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const at = nextRunAt({ ...job, lastRunAt: cursor }, cursor);
    runs.push(at);
    cursor = at;
  }
  return runs;
}

export function backoffDelayMs(attempt: number): number {
  if (attempt < 1) return 0;
  const growth = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(growth, MAX_BACKOFF_MS);
}

export function shouldRetry(job: Job): boolean {
  return job.state === "failed" && job.attempts < job.maxAttempts;
}

export function applyOutcome(job: Job, outcome: JobOutcome, at: number): Job {
  if (outcome.ok) {
    return {
      ...job,
      attempts: 0,
      lastRunAt: at,
      state: "idle",
      scheduledFor: nextRunAt({ ...job, lastRunAt: at }, at),
    };
  }

  const attempts = job.attempts + 1;
  const failed: Job = { ...job, attempts, lastRunAt: at, state: "failed" };
  if (!shouldRetry(failed)) {
    return { ...failed, state: "retired", scheduledFor: null };
  }
  return { ...failed, scheduledFor: at + backoffDelayMs(attempts) };
}

export function scheduleJob(job: Job, from: number): Job {
  if (job.state === "retired") return job;
  if (job.scheduledFor !== null && job.scheduledFor > from) return job;
  return { ...job, scheduledFor: nextRunAt(job, from) };
}

export function scheduleAll(jobs: Job[], from: number): Job[] {
  return jobs.map((job) => scheduleJob(job, from));
}

export function compareJobs(left: Job, right: Job): number {
  const leftDue = left.scheduledFor ?? Number.POSITIVE_INFINITY;
  const rightDue = right.scheduledFor ?? Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  if (left.priority !== right.priority) return right.priority - left.priority;
  return left.id.localeCompare(right.id);
}

export function dueJobs(jobs: Job[], now: number): Job[] {
  return jobs
    .filter((job) => job.state !== "running" && job.state !== "retired")
    .filter((job) => job.scheduledFor !== null && job.scheduledFor <= now)
    .sort(compareJobs);
}

export function timeUntil(job: Job, now: number): number | null {
  if (job.scheduledFor === null) return null;
  return Math.max(0, job.scheduledFor - now);
}

export function summarizeQueue(jobs: Job[]): QueueSummary {
  const summary: QueueSummary = {
    total: jobs.length,
    idle: 0,
    failed: 0,
    retired: 0,
    nextUp: null,
  };

  for (const job of jobs) {
    if (job.state === "idle") summary.idle += 1;
    if (job.state === "failed") summary.failed += 1;
    if (job.state === "retired") summary.retired += 1;
  }

  const upcoming = [...jobs].sort(compareJobs).find((job) => job.scheduledFor !== null);
  summary.nextUp = upcoming === undefined ? null : upcoming.name;
  return summary;
}
