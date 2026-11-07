import type { RoutineView } from "./routine-schema";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: string) => value.padStart(2, "0");

/** Plain words for common five-field cron schedules; anything else is shown as written. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "Enter five cron fields: minute hour day month weekday";
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const fixed = (value: string) => /^\d{1,2}$/.test(value);
  if (day !== "*" || month !== "*") return `Cron ${cron.trim()}`;
  if (fixed(minute) && hour === "*" && weekday === "*")
    return minute === "0" ? "Every hour" : `Every hour at :${pad(minute)}`;
  const everyHours = hour.match(/^\*\/(\d+)$/);
  if (fixed(minute) && everyHours && weekday === "*") return `Every ${everyHours[1]} hours`;
  if (!fixed(minute) || !fixed(hour)) return `Cron ${cron.trim()}`;
  const time = `${pad(hour)}:${pad(minute)}`;
  if (weekday === "*") return `Every day at ${time}`;
  if (weekday === "1-5") return `Weekdays at ${time}`;
  if (weekday === "0,6" || weekday === "6,0") return `Weekends at ${time}`;
  if (/^[0-6]$/.test(weekday)) return `Every ${DAYS[Number(weekday)]} at ${time}`;
  return `Cron ${cron.trim()}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];
const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function relativeTime(at: number, now = Date.now()): string {
  const delta = at - now;
  for (const [unit, size] of UNITS)
    if (Math.abs(delta) >= size) return format.format(Math.round(delta / size), unit);
  return delta >= 0 ? "in under a minute" : "just now";
}

/** The same saved schedule status wherever a routine appears. */
export function routineStatus(routine: Pick<RoutineView, "automation">, now = Date.now()): string {
  const automation = routine.automation;
  if (!automation) return "Unavailable";
  if (!automation.enabled) return "Paused";
  return automation.nextRunAt ? `Next ${relativeTime(automation.nextRunAt, now)}` : "Scheduled";
}
