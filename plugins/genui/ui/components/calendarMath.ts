// Calendar-heatmap arithmetic on whole days. A day is its number since
// 1970-01-01 in UTC, so `yyyy-mm-dd` strings map to days and back without any
// time zone ever moving one across midnight. No DOM: testable in node.
import { finiteNumber, isObject } from "../values";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** A real calendar date written `yyyy-mm-dd` as its day number; anything else is null. */
export function parseDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2026-02-30 over to March and maps years below 100 into the 1900s.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

/** The `yyyy-mm-dd` of a day number. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** "Tue, Mar 4, 2026". */
export function dayLabel(day: number): string {
  return DAY_FORMAT.format(new Date(day * DAY_MS));
}

/** 0 for Sunday … 6 for Saturday; day 0 (1970-01-01) was a Thursday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

export interface CalendarDays {
  /** Day number → value; repeated dates add up. */
  readonly values: ReadonlyMap<number, number>;
  /** Entries without a valid date or a number. */
  readonly dropped: number;
}

/**
 * `{yyyy-mm-dd: n}`, or a list of `{date, value}` (or `[date, value]`). A
 * listed date without a value counts once, so a list of events works too.
 */
export function readDays(days: unknown): CalendarDays {
  const entries: [unknown, unknown][] = Array.isArray(days)
    ? days.map((item): [unknown, unknown] =>
        Array.isArray(item)
          ? [item[0], item[1] ?? 1]
          : isObject(item)
            ? [item.date, item.value === undefined ? 1 : item.value]
            : [item, 1],
      )
    : isObject(days)
      ? Object.entries(days)
      : [];
  const values = new Map<number, number>();
  let dropped = 0;
  for (const [date, value] of entries) {
    const day = parseDay(date);
    const number = finiteNumber(value);
    if (day === null || number === null) {
      dropped += 1;
      continue;
    }
    values.set(day, (values.get(day) ?? 0) + number);
  }
  return { values, dropped };
}

export interface CalendarLayout {
  /** The Sunday on or before the first day: column 0, row 0. */
  readonly start: number;
  readonly weeks: number;
  /** Month names over the columns where a month begins. */
  readonly months: readonly { readonly week: number; readonly label: string }[];
}

/** Week columns (Sunday on top) from `first` to `last`, and where to name each month. */
export function calendarLayout(first: number, last: number): CalendarLayout {
  const start = first - weekday(first);
  const weeks = Math.floor((last - start) / 7) + 1;
  const months: { week: number; label: string }[] = [];
  for (let week = 0; week < weeks; week++) {
    for (let row = 0; row < 7; row++) {
      const day = start + week * 7 + row;
      if (day < first || day > last) continue;
      const date = new Date(day * DAY_MS);
      // The first column, and every column holding a 1st.
      if (day === first || date.getUTCDate() === 1) {
        months.push({ week, label: MONTHS[date.getUTCMonth()]! });
        break;
      }
    }
  }
  // A month that starts the range late gets no room before the next one's name.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  return { start, weeks, months };
}

export interface CalendarStats {
  readonly total: number;
  /** Days with a value above zero. */
  readonly active: number;
  /** The highest value, and the first day it was reached; null without days. */
  readonly peak: { readonly day: number; readonly value: number } | null;
}

export function calendarStats(values: ReadonlyMap<number, number>): CalendarStats {
  let total = 0;
  let active = 0;
  let peak: { day: number; value: number } | null = null;
  for (const day of [...values.keys()].sort((a, b) => a - b)) {
    const value = values.get(day)!;
    // Float noise from adding 0.1s must not show as 0.30000000000000004.
    total = Number((total + value).toPrecision(12));
    if (value > 0) active += 1;
    if (peak === null || value > peak.value) peak = { day, value };
  }
  return { total, active, peak };
}
