import { lineLabel } from "./citation-patch.ts";

const RANGE_CONTEXT_LINES = 2;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u;

type HunkLine = {
  text: string;
  kind: " " | "-" | "+" | "\\";
  /** Position on the new side used to decide whether the line falls in the range. */
  anchor: number;
  oldNext: number;
  newNext: number;
};

type Hunk = { trailer: string; lines: HunkLine[] };

function parseHunks(body: string[]): Hunk[] | null {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldNext = 0;
  let newNext = 0;
  for (const text of body) {
    const header = HUNK_HEADER.exec(text);
    if (header !== null) {
      oldNext = Number(header[1]);
      newNext = Number(header[3]);
      hunk = { trailer: header[5] ?? "", lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (hunk === null) return null;
    const marker = text.length === 0 ? " " : text[0];
    if (marker === "\\") {
      hunk.lines.push({ text, kind: "\\", anchor: newNext, oldNext, newNext });
      continue;
    }
    if (marker !== " " && marker !== "-" && marker !== "+") return null;
    const line: HunkLine = { text, kind: marker, anchor: newNext, oldNext, newNext };
    if (marker === " ") {
      oldNext += 1;
      newNext += 1;
    } else if (marker === "-") {
      oldNext += 1;
    } else {
      newNext += 1;
    }
    hunk.lines.push(line);
  }
  return hunks;
}

function hunkHeader(lines: HunkLine[], trailer: string): string {
  const first = lines[0]!;
  const oldCount = lines.filter((line) => line.kind === " " || line.kind === "-").length;
  const newCount = lines.filter((line) => line.kind === " " || line.kind === "+").length;
  const oldStart = oldCount === 0 ? Math.max(0, first.oldNext - 1) : first.oldNext;
  const newStart = newCount === 0 ? Math.max(0, first.newNext - 1) : first.newNext;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailer}`;
}

/**
 * Keep only the hunk lines that touch `start`..`end` on the new side of a
 * unified diff, plus two lines of context. Deleted lines count at the new-side
 * position where they used to be.
 */
export function rangePatch(
  path: string,
  patch: string,
  requestedStart?: number,
  requestedEnd?: number,
): { label: string; patch: string } | { empty: string } | { error: string } {
  const start = requestedStart ?? 1;
  const end = requestedEnd ?? start;
  if (end < start) {
    return { error: "The diff end line must not come before its start line." };
  }
  const label = lineLabel(path, start, end);

  const source = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  const firstHunk = source.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) return { empty: `No changes found in ${label}.` };
  const hunks = parseHunks(source.slice(firstHunk));
  if (hunks === null) return { error: `Could not read the diff for ${path}.` };

  const low = start - RANGE_CONTEXT_LINES;
  const high = end + RANGE_CONTEXT_LINES;
  const output = source.slice(0, firstHunk);
  let changed = false;
  for (const hunk of hunks) {
    const kept: HunkLine[] = [];
    let previousKept = false;
    for (const line of hunk.lines) {
      const keep: boolean =
        line.kind === "\\" ? previousKept : line.anchor >= low && line.anchor <= high;
      if (keep) kept.push(line);
      previousKept = keep;
    }
    const content = kept.filter((line) => line.kind !== "\\");
    if (content.length === 0) continue;
    if (content.some((line) => line.kind !== " ")) changed = true;
    output.push(hunkHeader(content, hunk.trailer), ...kept.map((line) => line.text));
  }
  if (!changed) return { empty: `No changes found in ${label}.` };
  return { label, patch: `${output.join("\n")}\n` };
}
