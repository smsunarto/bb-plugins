/**
 * Presentation helpers, pure so the tab's labels are unit-testable. Ported
 * from `plugins/gitbutler/src/app/format.ts`.
 */

/** Joins class names, skipping the falsy ones. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function shortId(commitId: string): string {
  return commitId.slice(0, 7);
}

/** `origin/main` as a reader names it: `main`. */
export function shortRef(ref: string): string {
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(slash + 1) : ref;
}

/**
 * What a branch's commits, given newest first, are squashed into when it
 * lands: the subject of the oldest, which started the branch, then the later
 * subjects as a list, oldest first.
 */
export function squashMessage(newestFirst: readonly string[]): string {
  const [first = "", ...later] = newestFirst.toReversed();
  return later.length === 0 ? first : `${first}\n\n${later.map((line) => `- ${line}`).join("\n")}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A commit's age as a branch card shows it: "now", "38m", "2h", "3d", then the date. */
export function shortAge(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Made once: a card draws one per commit, and building a format is the slow part.
const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** The date and time in full, for a tooltip under a short age. */
export function absoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "" : absoluteFormat.format(timestamp);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
