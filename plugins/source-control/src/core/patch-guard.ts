/**
 * The last check before a patch file draws. The reader marks each source
 * line it claims for a file; this recounts on its own terms and fails the
 * read when the two disagree:
 *
 * - every source line that reads as a hunk line (`+` or `-`) inside a diff
 *   must be claimed, unless it is a mail signature or the mail's MIME
 *   boundary;
 * - the patch text each card hands the renderer must hold, hunk by hunk, the
 *   lines its headers count, as many as the source has for that file, and
 *   the file's +/− totals;
 * - drawn and left-out hunk lines together must be every claimed one.
 *
 * So a parser mistake shows the file as text with a reason, never as a diff
 * missing lines.
 */
import type { PatchFileEntry } from "./patch-file.ts";

/** What a source line is to the reader. */
export const CLAIM = { none: 0, header: 1, hunk: 2 } as const;

/** Where a commit starts in the source, and the MIME boundary its mail declares. */
export type Section = { start: number; boundary: string | null };

/** A file read from `start` to `end`, its hunk lines, and its card, null when left out. */
export type DrawnFile = { start: number; end: number; body: number; entry: PatchFileEntry | null };

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A mail line that ends a patch's text: the signature's `-- `; `--` once an
 * editor trimmed its space, when git's version line follows; or the MIME
 * boundary the mail declares (`format-patch --attach` or `--inline`).
 */
export function isMailTrailer(
  line: string,
  next: string | undefined,
  boundary: string | null,
): boolean {
  if (line === "-- ") return true;
  if (line === "--") return /^\d+(?:\.\d+)+/.test(next ?? "");
  return boundary !== null && (line === `--${boundary}` || line === `--${boundary}--`);
}

/** Why the drawn copy would lose or misplace lines, or null when it holds them all. */
export function checkDrawn(
  lines: readonly string[],
  claims: Uint8Array,
  sections: readonly Section[],
  drawn: readonly DrawnFile[],
): string | null {
  return unclaimedLine(lines, claims, sections) ?? countsDiffer(claims, drawn);
}

/** The first `+` or `-` line inside a diff that no file claims. */
function unclaimedLine(
  lines: readonly string[],
  claims: Uint8Array,
  sections: readonly Section[],
): string | null {
  let section = 0;
  let inDiff = false;
  let boundary: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    // A commit's header and message come before its first file: they are no diff.
    if (sections[section]?.start === index) {
      inDiff = false;
      boundary = sections[section]!.boundary;
      section++;
    }
    if (claims[index] !== CLAIM.none) {
      inDiff = true;
      continue;
    }
    const line = lines[index]!;
    if (!inDiff || !/^[+-]/.test(line) || isMailTrailer(line, lines[index + 1], boundary)) continue;
    return `Line ${index + 1} reads as a hunk line, but no file's hunk holds it.`;
  }
  return null;
}

function countsDiffer(claims: Uint8Array, drawn: readonly DrawnFile[]): string | null {
  let claimed = 0;
  for (const claim of claims) if (claim === CLAIM.hunk) claimed++;
  let held = 0;
  for (const file of drawn) {
    const { entry } = file;
    const inSource = claimedIn(claims, file.start, file.end);
    if (inSource !== file.body) return differs(entry);
    held += file.body;
    // Left out (past the file cap), too large, or with no hunks: the card draws no lines.
    if (entry === null || entry.patch.truncated || entry.patch.patch === "") {
      if (entry && !entry.patch.truncated && file.body !== 0) return differs(entry);
      continue;
    }
    const counted = recount(entry.patch.patch);
    if (
      counted === null ||
      counted.body !== file.body ||
      counted.additions !== entry.file.additions ||
      counted.deletions !== entry.file.deletions
    )
      return differs(entry);
  }
  return held === claimed
    ? null
    : "The diff view's copy doesn't hold every hunk line of this file.";
}

const differs = (entry: PatchFileEntry | null) =>
  `The diff view's copy of ${entry?.file.path ?? "a file"} doesn't match its lines in this file.`;

function claimedIn(claims: Uint8Array, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index++) if (claims[index] === CLAIM.hunk) count++;
  return count;
}

/** A card's patch walked hunk by hunk against its headers: its hunk lines and +/−, or null when they disagree. */
function recount(patch: string): { body: number; additions: number; deletions: number } | null {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let index = lines.findIndex((line) => line.startsWith("@@"));
  if (index < 0) return null;
  const counted = { body: 0, additions: 0, deletions: 0 };
  while (index < lines.length) {
    const header = HUNK.exec(lines[index]!);
    if (!header) return null;
    const left = {
      old: header[1] === undefined ? 1 : Number(header[1]),
      next: header[2] === undefined ? 1 : Number(header[2]),
    };
    index++;
    while (left.old > 0 || left.next > 0) {
      if (index >= lines.length || !countHunkLine(lines[index]!, left, counted)) return null;
      index++;
    }
    while (lines[index]?.startsWith("\\")) {
      counted.body++;
      index++;
    }
  }
  return counted;
}

function countHunkLine(
  line: string,
  left: { old: number; next: number },
  counted: { body: number; additions: number; deletions: number },
): boolean {
  counted.body++;
  switch (line[0]) {
    case " ":
      left.old--;
      left.next--;
      break;
    case "-":
      left.old--;
      counted.deletions++;
      break;
    case "+":
      left.next--;
      counted.additions++;
      break;
    case "\\":
      return true;
    default:
      return false;
  }
  return left.old >= 0 && left.next >= 0;
}
