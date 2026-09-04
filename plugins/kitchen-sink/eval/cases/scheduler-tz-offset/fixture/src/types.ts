export type JobState = "idle" | "running" | "failed" | "retired";

export type Job = {
  id: string;
  name: string;
  queue: string;
  /** Wall-clock hour the job should fire at, in the calendar named by tzOffsetMinutes. */
  hour: number;
  minute: number;
  /** Minutes east of UTC for that calendar. Tokyo is 540, Los Angeles is -480. */
  tzOffsetMinutes: number;
  intervalMinutes: number | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastRunAt: number | null;
  scheduledFor: number | null;
  state: JobState;
};

export type Schedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "interval"; intervalMinutes: number };

export type JobOutcome = { ok: true } | { ok: false; error: string };

export type QueueSummary = {
  total: number;
  idle: number;
  failed: number;
  retired: number;
  nextUp: string | null;
};
