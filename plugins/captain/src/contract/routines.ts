/**
 * Routines: a scheduled message to one Captain. The shapes, limits and the
 * schedule in words, shared by the server and the app. Pure: no node or
 * server imports, so the app bundle imports it.
 */
import { z } from "zod";

export const ROUTINES_PER_CAPTAIN = 20;
export const ROUTINE_NAME_MAX = 80;
export const ROUTINE_INSTRUCTION_MAX = 4000;
/** Runs kept per routine. */
export const ROUTINE_RUNS_KEPT = 20;
/** A cron schedule fires at most this often: each run is a Captain turn on a large model. */
export const ROUTINE_MIN_INTERVAL_MINUTES = 15;
const CRON_MAX = 100;
const TIMEZONE_MAX = 100;

/** Whether `Intl` knows this IANA time zone. */
export function validTimezone(timezone: string): boolean {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone !== ""
    );
  } catch {
    return false;
  }
}

/**
 * The values one cron field allows, or null when it cannot be read: numbers,
 * `*`, ranges, steps and lists. Names such as `MON` are not expanded.
 */
export function expandCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/u.exec(part);
    if (match === null) return null;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;
    if (match[1] !== "*") {
      from = Number(match[2]);
      // `5/15` means from 5 to the end, as in Vixie cron.
      to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    }
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Why a five-field cron is refused, or null when it is accepted. The minute
 * and hour fields must be readable, and no two runs may come closer than
 * `ROUTINE_MIN_INTERVAL_MINUTES`, counting the gap across an hour boundary.
 */
export function cronProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length !== 5) return "a cron has five fields: minute hour day month weekday";
  const minutes = expandCronField(fields[0] as string, 0, 59);
  const hours = expandCronField(fields[1] as string, 0, 23);
  if (minutes === null || minutes.length === 0) return `cannot read the minute field ${fields[0]}`;
  if (hours === null || hours.length === 0) return `cannot read the hour field ${fields[1]}`;
  if (fields.slice(2).some((field) => !/^[\w*,/-]+$/u.test(field))) {
    return "cannot read the day, month or weekday field";
  }
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < minutes.length; i += 1) {
    gap = Math.min(gap, (minutes[i] as number) - (minutes[i - 1] as number));
  }
  // The last minute of one hour to the first of the next, when both hours run.
  const hourSet = new Set(hours);
  const nextHourRuns = hours.some((hour) => hourSet.has((hour + 1) % 24));
  if (nextHourRuns) {
    gap = Math.min(gap, 60 - (minutes[minutes.length - 1] as number) + (minutes[0] as number));
  }
  if (gap < ROUTINE_MIN_INTERVAL_MINUTES) {
    return `runs ${gap} minutes apart; a routine runs at most every ${ROUTINE_MIN_INTERVAL_MINUTES} minutes`;
  }
  return null;
}

export const cronScheduleSchema = z
  .object({
    cron: z
      .string()
      .trim()
      .min(1)
      .max(CRON_MAX)
      .transform((cron) => cron.split(/\s+/u).join(" "))
      .superRefine((cron, ctx) => {
        const problem = cronProblem(cron);
        if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
      }),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(TIMEZONE_MAX)
      .refine(validTimezone, { message: "unknown time zone; use an IANA name like Europe/Berlin" }),
  })
  .strict();

/** A one-shot: epoch milliseconds. */
export const onceScheduleSchema = z.object({ at: z.number().int().positive() }).strict();

export const scheduleSchema = z.union([cronScheduleSchema, onceScheduleSchema]);
export type Schedule = z.infer<typeof scheduleSchema>;
export type CronSchedule = z.infer<typeof cronScheduleSchema>;

export const routineNameSchema = z.string().trim().min(1).max(ROUTINE_NAME_MAX);
export const routineInstructionSchema = z.string().trim().min(1).max(ROUTINE_INSTRUCTION_MAX);

/** What the user sets on a routine. */
export const routineFieldsSchema = z
  .object({
    name: routineNameSchema.refine((name) => !/[\r\n]/u.test(name), {
      message: "a routine name is one line",
    }),
    instruction: routineInstructionSchema,
    schedule: scheduleSchema,
  })
  .strict();
export type RoutineFields = z.infer<typeof routineFieldsSchema>;

/** A routine as Captain stores it. Enabled, next and last run come from Automations. */
export const routineSchema = routineFieldsSchema
  .extend({
    /** Short, like asks: `r3`. */
    id: z.string().regex(/^r\d+$/u),
    captainId: z.string().min(1),
    /** The bb automation that schedules it; null only while it could not be made. */
    automationId: z.string().min(1).nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;

export const ROUTINE_RUN_TRIGGERS = ["schedule", "test"] as const;
/** Delivery states only: the Captain thread shows the work. */
export const ROUTINE_RUN_STATUSES = ["sent", "queued", "skipped", "failed"] as const;

export const routineRunSchema = z
  .object({
    id: z.number().int(),
    routineId: z.string(),
    trigger: z.enum(ROUTINE_RUN_TRIGGERS),
    status: z.enum(ROUTINE_RUN_STATUSES),
    reason: z.string().nullable(),
    at: z.number(),
  })
  .strict();
export type RoutineRun = z.infer<typeof routineRunSchema>;
export type RoutineRunTrigger = RoutineRun["trigger"];
export type RoutineRunStatus = RoutineRun["status"];

export const ROUTINE_ACTIONS = ["pause", "resume", "run", "delete"] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  const half = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${half}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

function listWords(words: readonly string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The schedule in words, as Grok's "When to run" shows it: daily, weekday,
 * weekly, hourly and monthly shapes, else `Custom schedule (<cron>)`. A
 * one-shot reads as its time in `timezone`.
 */
export function describeSchedule(schedule: Schedule, timezone?: string): string {
  if ("at" in schedule) {
    const when = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone === undefined ? {} : { timeZone: timezone }),
    }).format(new Date(schedule.at));
    return `Once, ${when}`;
  }
  return describeCron(schedule.cron);
}

const single = (field: string) => (/^\d{1,2}$/u.test(field) ? Number(field) : null);

export function describeCron(cron: string): string {
  const text = cron.trim().split(/\s+/u).join(" ");
  const fields = text.split(" ");
  const words =
    fields.length === 5 && fields[3] === "*"
      ? (frequentWords(fields) ?? calendarWords(fields))
      : null;
  return words ?? `Custom schedule (${text})`;
}

/** Every n minutes, every hour, every n hours. */
function frequentWords(fields: readonly string[]): string | null {
  const [minuteField = "", hourField = "", day, , weekday] = fields;
  if (day !== "*" || weekday !== "*") return null;
  const everyMinutes = /^\*\/(\d+)$/u.exec(minuteField);
  if (everyMinutes && hourField === "*") return `Every ${everyMinutes[1]} minutes`;
  const minute = single(minuteField);
  if (minute === null) return null;
  const past = minute === 0 ? "" : ` at :${pad(minute)}`;
  if (hourField === "*") return minute === 0 ? "Every hour" : `Every hour${past}`;
  const everyHours = /^\*\/(\d+)$/u.exec(hourField);
  return everyHours ? `Every ${everyHours[1]} hours${past}` : null;
}

/** One time of day: daily, on weekdays, on named days, or monthly. */
function calendarWords(fields: readonly string[]): string | null {
  const [minuteField = "", hourField = "", day = "", , weekday = ""] = fields;
  const minute = single(minuteField);
  const hour = single(hourField);
  if (minute === null || hour === null || hour > 23 || minute > 59) return null;
  const at = clock(hour, minute);
  if (day !== "*") {
    const date = single(day);
    const valid = date !== null && date >= 1 && date <= 31 && weekday === "*";
    return valid ? `Monthly on the ${ordinal(date)} at ${at}` : null;
  }
  if (weekday === "1-5") return `Every weekday at ${at}`;
  if (weekday === "0,6" || weekday === "6,0") return `Every weekend day at ${at}`;
  const days = weekday === "*" ? null : expandCronField(weekday.replace(/\b7\b/gu, "0"), 0, 6);
  if (weekday === "*" || days?.length === 7) return `Every day at ${at}`;
  if (days === null || days.length === 0) return null;
  return `Every ${listWords(days.map((d) => DAYS[d] as string))} at ${at}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
