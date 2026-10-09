import type { ReviewThread } from "../shared/schema.ts";

/* Presentation helpers. Pure, so the panel's labels are unit-testable. */

/** The page's `navPanel` path: `useBbNavigate().toPluginPanel(PANEL_PATH, { subPath })`. */
export const PANEL_PATH = "code-review";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. Empty for an unreadable value. */
export function relativeTime(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const ABSOLUTE_STYLE = { dateStyle: "medium", timeStyle: "short" } as const;
// Made once: a timeline draws one per item, and building a format is the slow part.
const absoluteFormat = new Intl.DateTimeFormat(undefined, ABSOLUTE_STYLE);

/**
 * The date and time in full, for a tooltip under a relative one. The reader's
 * locale and zone unless given, which only a test needs.
 */
export function absoluteTime(iso: string, locale?: string, timeZone?: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const format =
    locale === undefined && timeZone === undefined
      ? absoluteFormat
      : new Intl.DateTimeFormat(locale, { ...ABSOLUTE_STYLE, timeZone });
  return format.format(timestamp);
}

/** The 7-character abbreviation GitHub prints for a commit. */
export function shortSha(oid: string): string {
  return oid.slice(0, 7);
}

/** The count and its noun: `plural(1, "file")` is "1 file", `plural(3, "file")` is "3 files". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A commit message's first line. */
export function subject(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** "Line 12", or "Lines 10 to 12", and which side when it is the base's. */
export function threadLines(
  thread: Pick<ReviewThread, "line" | "startLine" | "startSide" | "originalLine" | "side">,
): string {
  const line = thread.line ?? thread.originalLine;
  if (line === null) return "File";
  const base = thread.side === "LEFT" ? " (base)" : "";
  // Base and head lines count different files, so each end names its own side.
  if (thread.startLine !== null && thread.startSide !== null && thread.startSide !== thread.side) {
    const startBase = thread.startSide === "LEFT" ? " (base)" : "";
    return `Lines ${thread.startLine}${startBase} to ${line}${base}`;
  }
  return thread.startLine !== null && thread.startLine !== line
    ? `Lines ${thread.startLine} to ${line}${base}`
    : `Line ${line}${base}`;
}
