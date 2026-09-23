import type { BranchStatus } from "../shared/schema.ts";

/** Presentation helpers. Pure, so the panel's labels are unit-testable. */

export function shortId(commitId: string): string {
  return commitId.slice(0, 7);
}

export function subject(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

export function body(message: string): string {
  const newline = message.indexOf("\n");
  return newline === -1 ? "" : message.slice(newline + 1).trim();
}

const BODY_PREVIEW_LINES = 6;
const BODY_PREVIEW_CHARACTERS = 400;

/**
 * A body big enough that leaving it open would push the file list off the
 * panel. Counted on the source text, so the answer does not depend on how
 * wide the panel happens to be.
 */
export function isLongBody(text: string): boolean {
  return text.split("\n").length > BODY_PREVIEW_LINES || text.length > BODY_PREVIEW_CHARACTERS;
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

export const BRANCH_STATUS_LABEL: Readonly<Record<BranchStatus, string>> = {
  unpushed: "unpushed",
  pushed: "pushed",
  diverged: "diverged",
  integrated: "integrated",
  conflicted: "conflicted",
  empty: "empty",
  unknown: "",
};

export function changeSymbol(kind: string): string {
  if (kind === "added") return "A";
  if (kind === "deleted") return "D";
  if (kind === "renamed") return "R";
  if (kind === "copied") return "C";
  return "M";
}
