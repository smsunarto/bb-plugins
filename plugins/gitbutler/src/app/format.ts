/** Presentation helpers. Pure, so the panel's labels are unit-testable. */

export function shortId(commitId: string): string {
  return commitId.slice(0, 7);
}

export function subject(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const ABSOLUTE_STYLE = { dateStyle: "medium", timeStyle: "short" } as const;
// Made once: a board draws one per commit, and building a format is the slow part.
const absoluteFormat = new Intl.DateTimeFormat(undefined, ABSOLUTE_STYLE);

/**
 * The date and time in full, for a tooltip under a relative one. The reader's
 * locale and zone unless given, which only a test needs.
 */
export function absoluteTime(value: string, locale?: string, timeZone?: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const format =
    locale === undefined && timeZone === undefined
      ? absoluteFormat
      : new Intl.DateTimeFormat(locale, { ...ABSOLUTE_STYLE, timeZone });
  return format.format(timestamp);
}
