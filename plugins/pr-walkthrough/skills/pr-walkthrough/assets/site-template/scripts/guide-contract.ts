// Parse and validate Guide-mode MDX against an exact Git patch.
//
// Run with Bun. This module is imported by compile-walkthrough.ts and by the
// git patch contract test; it has no CLI entrypoint of its own.

import { createHash } from "node:crypto";

export const PHASES: ReadonlyArray<readonly [string, string]> = [
  ["foundations", "Foundations and data structures"],
  ["apis", "APIs and entrypoints"],
  ["behavior", "Core behavior"],
  ["integration", "Integration and wiring"],
  ["tests", "Tests and verification"],
  ["misc", "Imports, formatting, and miscellaneous"],
  ["generated", "Generated output"],
];
const PHASE_BY_TITLE = new Map<string, readonly [number, string]>(
  PHASES.map(
    ([phaseId, title], index) =>
      [title, [index, phaseId] as const] as [string, readonly [number, string]],
  ),
);

const GUIDE_HEADING = "## Guide";
const PHASE_HEADING = /^### (.+?)\s*$/;
const EXCERPT_HEADING = /^#### (.+?)\s*$/;
const DIFF_DIRECTIVE = /^- Diff: `([a-z0-9][a-z0-9-]*)` \[([^\]]+)\]\(([^)]+)\)\s*$/;
const CONTEXT_DIRECTIVE = /^- Context: `([0-9]+)`\s*$/;
const COMMENT_DIRECTIVE = /^- Comment: ([LR])([0-9]+) — (.+?)\s*$/;
const SELECTOR = /^([LR])([0-9]+)(?:-([LR]?)([0-9]+))?$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIAGRAM_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UNORDERED_ITEM = /^[-*] (.+)$/;
const ORDERED_ITEM = /^[0-9]+\. (.+)$/;

export type LineSide = "deletions" | "additions";

export class GuideCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuideCompileError";
  }
}

// ---------------------------------------------------------------------------
// Python-compatible string helpers. The compiler was ported from Python, and
// the MDX and patch contracts depend on those exact splitting and stripping
// rules, so the helpers reproduce them instead of using looser JS defaults.
// ---------------------------------------------------------------------------

const LINE_BOUNDARIES = new Set([
  "\n",
  "\r",
  "\v",
  "\f",
  "\u001c",
  "\u001d",
  "\u001e",
  "\u0085",
  "\u2028",
  "\u2029",
]);

/** Split like Python's str.splitlines(): no trailing empty element. */
export function splitLines(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (!LINE_BOUNDARIES.has(character)) {
      index += 1;
      continue;
    }
    result.push(value.slice(start, index));
    index += character === "\r" && value[index + 1] === "\n" ? 2 : 1;
    start = index;
  }
  if (start < value.length) result.push(value.slice(start));
  return result;
}

/** Strip every leading and trailing character contained in `chars`. */
export function stripChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Strip trailing newlines only, like Python's str.rstrip("\n"). */
export function rstripNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "\n") end -= 1;
  return value.slice(0, end);
}

export function removePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function removeSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
}

/** Order strings by code point, like Python's str comparison. */
export function compareStrings(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const limit = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < limit; index += 1) {
    const a = leftPoints[index].codePointAt(0) ?? 0;
    const b = rightPoints[index].codePointAt(0) ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

// ---------------------------------------------------------------------------
// Changed-line references
// ---------------------------------------------------------------------------

export interface LineRef {
  side: LineSide;
  lineNumber: number;
}

export function lineRef(side: LineSide, lineNumber: number): LineRef {
  return { side, lineNumber };
}

/** Stable set/map key for one changed-line reference. */
export function refKey(ref: LineRef): string {
  return `${ref.side}:${String(ref.lineNumber)}`;
}

export function refFromKey(key: string): LineRef {
  const separator = key.indexOf(":");
  return {
    side: key.slice(0, separator) as LineSide,
    lineNumber: Number(key.slice(separator + 1)),
  };
}

/** Sort keys the way Python sorted its ordered LineRef dataclass. */
function compareRefKeys(left: string, right: string): number {
  const a = refFromKey(left);
  const b = refFromKey(right);
  if (a.side !== b.side) return a.side < b.side ? -1 : 1;
  return a.lineNumber - b.lineNumber;
}

function sortedRefKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted(compareRefKeys);
}

function formatRefTokens(keys: Iterable<string>): string {
  return sortedRefKeys(keys)
    .map((key) => {
      const ref = refFromKey(key);
      return `${ref.side === "deletions" ? "L" : "R"}${String(ref.lineNumber)}`;
    })
    .join(", ");
}

function formatRefRepr(keys: Iterable<string>): string {
  const items = sortedRefKeys(keys).map((key) => {
    const ref = refFromKey(key);
    return `LineRef(side='${ref.side}', line_number=${String(ref.lineNumber)})`;
  });
  return `[${items.join(", ")}]`;
}

function difference(left: Iterable<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) if (!right.has(value)) result.add(value);
  return result;
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) if (right.has(value)) result.add(value);
  return result;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Patch indexing
// ---------------------------------------------------------------------------

export type RowKind = "context" | "deletion" | "addition" | "no-newline";

export interface PatchRow {
  kind: RowKind;
  raw: string;
  oldLine: number | null;
  newLine: number | null;
  oldBefore: number;
  newBefore: number;
}

export interface PatchHunk {
  suffix: string;
  rows: PatchRow[];
}

export interface IndexedPatchFile {
  path: string;
  prelude: string[];
  hunks: PatchHunk[];
  originalPatch: string;
  changedRefs: Set<string>;
}

function rowChangedRef(row: PatchRow): LineRef | null {
  if (row.kind === "deletion" && row.oldLine !== null) return lineRef("deletions", row.oldLine);
  if (row.kind === "addition" && row.newLine !== null) return lineRef("additions", row.newLine);
  return null;
}

/** Split one section into its unchanged Normal source and required Guide source. */
export function splitGuideSection(lines: string[], context: string): [string[], string[]] {
  const matches: number[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("```")) inFence = !inFence;
    else if (!inFence && line === GUIDE_HEADING) matches.push(index);
  }
  if (inFence) throw new GuideCompileError(`${context} has an unterminated code fence`);
  if (matches.length === 0) {
    throw new GuideCompileError(`${context} needs exactly one ${GUIDE_HEADING} heading`);
  }
  if (matches.length > 1) {
    throw new GuideCompileError(`${context} repeats the ${GUIDE_HEADING} heading`);
  }
  const index = matches[0];
  return [lines.slice(0, index), lines.slice(index + 1)];
}

function stripGitPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

const GIT_ESCAPES = new Map<string, number>([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
  ["\\", 0x5c],
  ['"', 0x22],
]);

/** Decode one Git C-quoted, byte-oriented path without destabilizing bad input. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (value.length < 2 || !value.endsWith('"')) return value;
  const payload = value.slice(1, -1);
  const decoded: number[] = [];
  const encoder = new TextEncoder();
  let index = 0;
  while (index < payload.length) {
    const code = payload.codePointAt(index);
    if (code === undefined) return value;
    const character = String.fromCodePoint(code);
    if (character !== "\\") {
      for (const byte of encoder.encode(character)) decoded.push(byte);
      index += character.length;
      continue;
    }
    index += 1;
    if (index >= payload.length) return value;
    const escaped = payload[index];
    const mapped = GIT_ESCAPES.get(escaped);
    if (mapped !== undefined) {
      decoded.push(mapped);
      index += 1;
      continue;
    }
    if (escaped >= "0" && escaped <= "7") {
      let end = index + 1;
      const limit = Math.min(index + 3, payload.length);
      while (end < limit && payload[end] >= "0" && payload[end] <= "7") end += 1;
      const byte = Number.parseInt(payload.slice(index, end), 8);
      if (!Number.isInteger(byte) || byte > 0xff) return value;
      decoded.push(byte);
      index = end;
      continue;
    }
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(decoded));
  } catch {
    return value;
  }
}

/** Decode metadata paths while preserving spaces in their unquoted form. */
export function decodeGitMetadataPath(value: string): string {
  return decodeGitPath(value);
}

export function parseGitDiffHeader(line: string): [string, string] {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return ["", ""];
  const remainder = line.slice(prefix.length);
  if (remainder.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < remainder.length; index += 1) {
      const character = remainder[index];
      if (character === '"' && !escaped) {
        const oldField = remainder.slice(0, index + 1);
        const newField = remainder.slice(index + 1).replace(/^\s+/, "");
        if (!newField) return ["", ""];
        return [stripGitPrefix(decodeGitPath(oldField)), stripGitPrefix(decodeGitPath(newField))];
      }
      escaped = character === "\\" && !escaped;
    }
    return ["", ""];
  }

  const candidates: Array<[string, string]> = [];
  let offset = 0;
  for (;;) {
    const separator = remainder.indexOf(" b/", offset);
    if (separator < 0) break;
    candidates.push([remainder.slice(0, separator), remainder.slice(separator + 1)]);
    offset = separator + 1;
  }
  if (candidates.length === 0) return ["", ""];
  let chosen = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (stripGitPrefix(candidate[0]) === stripGitPrefix(candidate[1])) {
      chosen = candidate;
      break;
    }
  }
  return [stripGitPrefix(chosen[0]), stripGitPrefix(decodeGitPath(chosen[1]))];
}

/** Decode one ---/+++ path, including Git's tab delimiter for paths with spaces. */
export function decodeGitMarkerPath(value: string): string {
  const decoded = decodeGitPath(removeSuffix(value, "\t"));
  return decoded === "/dev/null" ? "" : stripGitPrefix(decoded);
}

function indexPatchBlock(block: string): IndexedPatchFile | null {
  const lines = rstripNewlines(block).split("\n");
  if (lines.length === 0 || !lines[0].startsWith("diff --git ")) return null;
  const header = parseGitDiffHeader(lines[0]);
  let oldPath = header[0];
  let newPath = header[1];
  let firstHunk = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("@@ ")) {
      firstHunk = index;
      break;
    }
  }
  let status = "modified";
  let renameTo = "";
  let copiedTo = "";
  for (const line of lines.slice(1, firstHunk)) {
    if (line.startsWith("new file mode ")) status = "added";
    else if (line.startsWith("deleted file mode ")) status = "deleted";
    else if (line.startsWith("--- ")) oldPath = decodeGitMarkerPath(removePrefix(line, "--- "));
    else if (line.startsWith("+++ ")) newPath = decodeGitMarkerPath(removePrefix(line, "+++ "));
    else if (line.startsWith("rename to ")) {
      renameTo = decodeGitMetadataPath(removePrefix(line, "rename to "));
      status = "renamed";
    } else if (line.startsWith("copy to ")) {
      copiedTo = decodeGitMetadataPath(removePrefix(line, "copy to "));
      status = "copied";
    }
  }
  const path = renameTo || copiedTo || (status === "deleted" ? oldPath : newPath);
  if (!path) return null;

  const prelude = lines.slice(0, firstHunk);
  const hunks: PatchHunk[] = [];
  let index = firstHunk;
  while (index < lines.length) {
    const match = HUNK_HEADER.exec(lines[index]);
    if (!match) {
      throw new GuideCompileError(
        `patch for ${path} contains an invalid hunk header: ${lines[index]}`,
      );
    }
    let oldCursor = Number(match[1]);
    let newCursor = Number(match[3]);
    const suffix = match[5] ?? "";
    index += 1;
    const rows: PatchRow[] = [];
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const raw = lines[index];
      const oldBefore = Math.max(0, oldCursor - 1);
      const newBefore = Math.max(0, newCursor - 1);
      if (raw.startsWith(" ")) {
        rows.push({
          kind: "context",
          raw,
          oldLine: oldCursor,
          newLine: newCursor,
          oldBefore,
          newBefore,
        });
        oldCursor += 1;
        newCursor += 1;
      } else if (raw.startsWith("-")) {
        rows.push({
          kind: "deletion",
          raw,
          oldLine: oldCursor,
          newLine: null,
          oldBefore,
          newBefore,
        });
        oldCursor += 1;
      } else if (raw.startsWith("+")) {
        rows.push({
          kind: "addition",
          raw,
          oldLine: null,
          newLine: newCursor,
          oldBefore,
          newBefore,
        });
        newCursor += 1;
      } else if (raw.startsWith("\\ No newline at end of file")) {
        rows.push({ kind: "no-newline", raw, oldLine: null, newLine: null, oldBefore, newBefore });
      } else {
        throw new GuideCompileError(`patch for ${path} contains an invalid hunk row: ${raw}`);
      }
      index += 1;
    }
    hunks.push({ suffix, rows });
  }

  const changedRefs = new Set<string>();
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      const ref = rowChangedRef(row);
      if (ref !== null) changedRefs.add(refKey(ref));
    }
  }
  return { path, prelude, hunks, originalPatch: `${rstripNewlines(block)}\n`, changedRefs };
}

export function splitPatchBlocks(patch: string): string[] {
  return patch.split(/(?=^diff --git )/m);
}

export function indexPatch(patch: string): Map<string, IndexedPatchFile> {
  const result = new Map<string, IndexedPatchFile>();
  for (const block of splitPatchBlocks(patch)) {
    const indexed = block.startsWith("diff --git ") ? indexPatchBlock(block) : null;
    if (indexed === null) continue;
    if (result.has(indexed.path)) {
      throw new GuideCompileError(`patch repeats changed file ${indexed.path}`);
    }
    result.set(indexed.path, indexed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Selectors and synthesized excerpt patches
// ---------------------------------------------------------------------------

function parseSelector(target: string, context: string): LineRef[] | null {
  if (target === "-") return null;
  if (!target.startsWith("#") || target.length === 1) {
    throw new GuideCompileError(
      `${context} Diff target must be - or changed-line selectors such as #L10-L12,R10-R13`,
    );
  }
  const refs: LineRef[] = [];
  for (const token of target.slice(1).split(",")) {
    const match = SELECTOR.exec(token);
    if (!match) {
      throw new GuideCompileError(`${context} has an invalid changed-line selector: ${token}`);
    }
    const sideToken = match[1];
    const startToken = match[2];
    const endSideToken = match[3] ?? "";
    const endToken = match[4];
    if (endSideToken && endSideToken !== sideToken) {
      throw new GuideCompileError(`${context} crosses line sides inside one range: ${token}`);
    }
    const start = Number(startToken);
    const end = Number(endToken || startToken);
    if (start < 1 || end < start) {
      throw new GuideCompileError(`${context} has an invalid changed-line range: ${token}`);
    }
    if (end - start > 10_000) {
      throw new GuideCompileError(`${context} changed-line range is unreasonably large: ${token}`);
    }
    const side: LineSide = sideToken === "L" ? "deletions" : "additions";
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      refs.push(lineRef(side, lineNumber));
    }
  }
  const unique = new Set(refs.map(refKey));
  if (unique.size !== refs.length) {
    throw new GuideCompileError(`${context} repeats a changed-line selector`);
  }
  return refs;
}

function formatRangeLabel(refs: LineRef[] | null): string {
  if (refs === null) return "Whole file";
  const groups: string[] = [];
  for (const [side, prefix] of [
    ["deletions", "L"],
    ["additions", "R"],
  ] as const) {
    const numbers = [
      ...new Set(refs.filter((ref) => ref.side === side).map((ref) => ref.lineNumber)),
    ].toSorted((a, b) => a - b);
    const ranges: string[] = [];
    let startIndex = 0;
    while (startIndex < numbers.length) {
      let endIndex = startIndex;
      while (endIndex + 1 < numbers.length && numbers[endIndex + 1] === numbers[endIndex] + 1) {
        endIndex += 1;
      }
      const start = numbers[startIndex];
      const end = numbers[endIndex];
      ranges.push(
        start === end ? `${prefix}${String(start)}` : `${prefix}${String(start)}–${String(end)}`,
      );
      startIndex = endIndex + 1;
    }
    if (ranges.length > 0) groups.push(ranges.join(", "));
  }
  return groups.join(" · ");
}

function visibleRefs(rows: PatchRow[]): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    if (row.kind === "deletion" && row.oldLine !== null) {
      result.add(refKey(lineRef("deletions", row.oldLine)));
    } else if (row.kind === "addition" && row.newLine !== null) {
      result.add(refKey(lineRef("additions", row.newLine)));
    } else if (row.kind === "context" && row.oldLine !== null && row.newLine !== null) {
      result.add(refKey(lineRef("deletions", row.oldLine)));
      result.add(refKey(lineRef("additions", row.newLine)));
    }
  }
  return result;
}

function syntheticHunk(
  hunk: PatchHunk,
  refs: Set<string>,
  contextLines: number,
): [string[], Set<string>] {
  const rows = hunk.rows;
  const selectedIndices: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const ref = rowChangedRef(rows[index]);
    if (ref !== null && refs.has(refKey(ref))) selectedIndices.push(index);
  }
  if (selectedIndices.length === 0) return [[], new Set<string>()];

  const intervals: Array<[number, number]> = [];
  for (const selected of selectedIndices) {
    let left = selected;
    let remaining = contextLines;
    let cursor = selected - 1;
    while (cursor >= 0 && remaining > 0) {
      const row = rows[cursor];
      if (row.kind === "no-newline") {
        cursor -= 1;
        continue;
      }
      if (row.kind !== "context") break;
      left = cursor;
      remaining -= 1;
      cursor -= 1;
    }

    let right = selected;
    remaining = contextLines;
    cursor = selected + 1;
    while (cursor < rows.length && remaining > 0) {
      const row = rows[cursor];
      if (row.kind === "no-newline") {
        right = cursor;
        cursor += 1;
        continue;
      }
      if (row.kind !== "context") break;
      right = cursor;
      remaining -= 1;
      cursor += 1;
    }
    if (right + 1 < rows.length && rows[right + 1].kind === "no-newline") right += 1;
    intervals.push([left, right]);
  }

  intervals.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const merged: Array<[number, number]> = [];
  for (const [left, right] of intervals) {
    const last = merged[merged.length - 1];
    if (!last || left > last[1] + 1) merged.push([left, right]);
    else last[1] = Math.max(last[1], right);
  }

  const rendered: string[] = [];
  const visible = new Set<string>();
  for (const [left, right] of merged) {
    const selectedRows = rows.slice(left, right + 1);
    const contentRows = selectedRows.filter((row) => row.kind !== "no-newline");
    if (contentRows.length === 0) continue;
    const oldRows = contentRows.filter((row) => row.oldLine !== null);
    const newRows = contentRows.filter((row) => row.newLine !== null);
    const first = contentRows[0];
    const oldStart = oldRows.length > 0 ? (oldRows[0].oldLine as number) : first.oldBefore;
    const newStart = newRows.length > 0 ? (newRows[0].newLine as number) : first.newBefore;
    rendered.push(
      `@@ -${String(oldStart)},${String(oldRows.length)} +${String(newStart)},${String(
        newRows.length,
      )} @@${hunk.suffix}`,
    );
    for (const row of selectedRows) rendered.push(row.raw);
    for (const key of visibleRefs(selectedRows)) visible.add(key);
  }
  return [rendered, visible];
}

export function synthesizePatch(
  indexed: IndexedPatchFile,
  refs: LineRef[],
  contextLines: number,
): [string, Set<string>] {
  const selected = new Set(refs.map(refKey));
  const renderedHunks: string[] = [];
  const visible = new Set<string>();
  for (const hunk of indexed.hunks) {
    const [rendered, hunkVisible] = syntheticHunk(hunk, selected, contextLines);
    for (const line of rendered) renderedHunks.push(line);
    for (const key of hunkVisible) visible.add(key);
  }
  const renderedChanged = intersection(visible, indexed.changedRefs);
  if (!sameSet(renderedChanged, selected)) {
    const missing = difference(selected, renderedChanged);
    throw new GuideCompileError(
      `failed to synthesize exact excerpt for ${indexed.path}; missing ${formatRefRepr(missing)}`,
    );
  }
  const output = [...indexed.prelude, ...renderedHunks];
  return [`${rstripNewlines(output.join("\n"))}\n`, visible];
}

// ---------------------------------------------------------------------------
// Explanations and diagrams
// ---------------------------------------------------------------------------

export type ExplanationBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; code: string; language?: string }
  | { type: "quote"; text: string };

function isFence(line: string): boolean {
  return line.trim().startsWith("```");
}

function parseExplanationBlocks(lines: string[], context: string): ExplanationBlock[] {
  const blocks: ExplanationBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const stripped = lines[index].trim();
    if (!stripped) {
      index += 1;
      continue;
    }
    if (stripped.startsWith("```")) {
      const language = stripped.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "```") {
        code.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) {
        throw new GuideCompileError(`${context} has an unterminated code fence`);
      }
      if (language === "guide-diagram") {
        throw new GuideCompileError(`${context} may not place a guide-diagram inside an excerpt`);
      }
      const block: ExplanationBlock = { type: "code", code: code.join("\n") };
      if (language) block.language = language;
      blocks.push(block);
      index += 1;
      continue;
    }
    const unordered = UNORDERED_ITEM.exec(stripped);
    const ordered = ORDERED_ITEM.exec(stripped);
    if (unordered || ordered) {
      const isOrdered = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        const match = isOrdered ? ORDERED_ITEM.exec(candidate) : UNORDERED_ITEM.exec(candidate);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }
    if (stripped.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(removePrefix(lines[index].trim(), ">").replace(/^\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }

    const paragraph = [stripped];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index].trim();
      if (
        !candidate ||
        isFence(candidate) ||
        UNORDERED_ITEM.test(candidate) ||
        ORDERED_ITEM.test(candidate) ||
        candidate.startsWith(">")
      ) {
        break;
      }
      paragraph.push(candidate);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  if (blocks.length === 0) throw new GuideCompileError(`${context} needs explanatory Markdown`);
  return blocks;
}

export interface GuideDiagramNode {
  id: string;
  label: string;
  x: number;
  y: number;
  detail?: string;
}

export interface GuideDiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface GuideDiagram {
  summary: string;
  nodes: GuideDiagramNode[];
  edges: GuideDiagramEdge[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraKeys(value: JsonRecord, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function edgeDigest(source: string, target: string, label: string): string {
  // NUL-separated, matching the digest the previous Python compiler produced.
  return createHash("sha256")
    .update(`${source}\u0000${target}\u0000${label}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

function validateDiagram(payload: unknown, context: string): GuideDiagram {
  if (!isRecord(payload)) {
    throw new GuideCompileError(`${context} guide-diagram must contain one JSON object`);
  }
  const unknownKeys = extraKeys(payload, ["summary", "nodes", "edges"]);
  if (unknownKeys.length > 0) {
    throw new GuideCompileError(
      `${context} guide-diagram has unsupported keys: ${unknownKeys.toSorted(compareStrings).join(", ")}`,
    );
  }
  const summary = payload.summary;
  const nodes = payload.nodes;
  const edges = payload.edges;
  if (typeof summary !== "string" || !summary.trim()) {
    throw new GuideCompileError(`${context} guide-diagram needs a text summary`);
  }
  if (!Array.isArray(nodes) || nodes.length < 2) {
    throw new GuideCompileError(`${context} guide-diagram needs at least two nodes`);
  }
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new GuideCompileError(`${context} guide-diagram needs at least one edge`);
  }

  const compiledNodes: GuideDiagramNode[] = [];
  const nodeIds = new Set<string>();
  for (let position = 0; position < nodes.length; position += 1) {
    const index = position + 1;
    const node: unknown = nodes[position];
    if (!isRecord(node) || extraKeys(node, ["id", "label", "detail", "x", "y"]).length > 0) {
      throw new GuideCompileError(
        `${context} guide-diagram node ${String(index)} has invalid fields`,
      );
    }
    const nodeId = node.id;
    const label = node.label;
    const detail = node.detail;
    const x = node.x;
    const y = node.y;
    if (typeof nodeId !== "string" || !DIAGRAM_NODE_ID.test(nodeId)) {
      throw new GuideCompileError(
        `${context} guide-diagram node ${String(index)} needs a stable id`,
      );
    }
    if (nodeIds.has(nodeId)) {
      throw new GuideCompileError(`${context} guide-diagram repeats node id ${nodeId}`);
    }
    if (typeof label !== "string" || !label.trim()) {
      throw new GuideCompileError(`${context} guide-diagram node ${nodeId} needs a label`);
    }
    if (detail !== undefined && detail !== null && typeof detail !== "string") {
      throw new GuideCompileError(`${context} guide-diagram node ${nodeId} detail must be text`);
    }
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new GuideCompileError(
        `${context} guide-diagram node ${nodeId} needs finite x/y coordinates`,
      );
    }
    const compiled: GuideDiagramNode = { id: nodeId, label: label.trim(), x, y };
    if (typeof detail === "string" && detail) compiled.detail = detail.trim();
    compiledNodes.push(compiled);
    nodeIds.add(nodeId);
  }

  const compiledEdges: GuideDiagramEdge[] = [];
  const seenEdges = new Set<string>();
  for (let position = 0; position < edges.length; position += 1) {
    const index = position + 1;
    const edge: unknown = edges[position];
    if (!isRecord(edge) || extraKeys(edge, ["source", "target", "label"]).length > 0) {
      throw new GuideCompileError(
        `${context} guide-diagram edge ${String(index)} has invalid fields`,
      );
    }
    const source = edge.source;
    const target = edge.target;
    const label = edge.label;
    if (typeof source !== "string" || !nodeIds.has(source)) {
      throw new GuideCompileError(
        `${context} guide-diagram edge ${String(index)} has unknown source`,
      );
    }
    if (typeof target !== "string" || !nodeIds.has(target)) {
      throw new GuideCompileError(
        `${context} guide-diagram edge ${String(index)} has unknown target`,
      );
    }
    if (label !== undefined && label !== null && typeof label !== "string") {
      throw new GuideCompileError(
        `${context} guide-diagram edge ${String(index)} label must be text`,
      );
    }
    const labelText = typeof label === "string" ? label : "";
    const signature = `${source}\u0000${target}\u0000${labelText}`;
    if (seenEdges.has(signature)) {
      throw new GuideCompileError(`${context} guide-diagram repeats an edge`);
    }
    const compiled: GuideDiagramEdge = {
      id: `edge-${edgeDigest(source, target, labelText)}`,
      source,
      target,
    };
    if (labelText) compiled.label = labelText.trim();
    compiledEdges.push(compiled);
    seenEdges.add(signature);
  }
  return { summary: summary.trim(), nodes: compiledNodes, edges: compiledEdges };
}

function extractDiagram(lines: string[], context: string): [string[], GuideDiagram | null] {
  const remaining: string[] = [];
  let diagram: GuideDiagram | null = null;
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() !== "```guide-diagram") {
      remaining.push(lines[index]);
      index += 1;
      continue;
    }
    if (diagram !== null) {
      throw new GuideCompileError(`${context} may contain at most one guide-diagram`);
    }
    const payloadLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "```") {
      payloadLines.push(lines[index]);
      index += 1;
    }
    if (index >= lines.length) {
      throw new GuideCompileError(`${context} has an unterminated guide-diagram`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadLines.join("\n"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GuideCompileError(`${context} guide-diagram is invalid JSON: ${detail}`);
    }
    diagram = validateDiagram(payload, context);
    remaining.push("");
    index += 1;
  }
  return [remaining, diagram];
}

function splitSections(
  lines: string[],
  pattern: RegExp,
  context: string,
): [string[], Array<[string, string[]]>] {
  const prelude: string[] = [];
  const sections: Array<[string, string[]]> = [];
  let current: [string, string[]] | null = null;
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    const match = inFence ? null : pattern.exec(line);
    if (match) {
      if (current !== null) sections.push(current);
      current = [match[1], []];
    } else if (current === null) {
      prelude.push(line);
    } else {
      current[1].push(line);
    }
  }
  if (inFence) throw new GuideCompileError(`${context} has an unterminated code fence`);
  if (current !== null) sections.push(current);
  return [prelude, sections];
}

// ---------------------------------------------------------------------------
// Guide compilation
// ---------------------------------------------------------------------------

export interface DiffFileSummary {
  path: string;
  url?: string;
  additions?: number;
  deletions?: number;
  generated?: boolean;
  binary?: boolean;
}

export interface GuideComment {
  id: string;
  side: LineSide;
  lineNumber: number;
  body: string;
}

export interface GuideExcerpt {
  id: string;
  title: string;
  explanation: ExplanationBlock[];
  path: string;
  url: string;
  patch: string;
  rangeLabel: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generated: boolean;
  countsTowardCompletion: boolean;
  defaultCollapsed: boolean;
  comments: GuideComment[];
}

export interface GuidePhase {
  id: string;
  title: string;
  explanation: ExplanationBlock[];
  excerpts: GuideExcerpt[];
  defaultCollapsed: boolean;
  diagram?: GuideDiagram;
}

function parseExcerpt(
  title: string,
  lines: string[],
  options: {
    groupId: string;
    phaseId: string;
    groupPaths: Set<string>;
    diffByPath: Map<string, DiffFileSummary>;
    patchByPath: Map<string, IndexedPatchFile>;
  },
): [GuideExcerpt, Set<string>] {
  const { groupId, phaseId, groupPaths, diffByPath, patchByPath } = options;
  let localId = "";
  let path = "";
  let target = "";
  let contextLines = 3;
  let contextSeen = false;
  const comments: Array<[LineRef, string]> = [];
  const explanationLines: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      explanationLines.push(rawLine);
      continue;
    }
    if (!inFence) {
      const diffMatch = DIFF_DIRECTIVE.exec(stripped);
      if (diffMatch) {
        if (localId) {
          throw new GuideCompileError(`Guide excerpt ${title} repeats its Diff directive`);
        }
        localId = diffMatch[1];
        path = diffMatch[2];
        target = diffMatch[3];
        continue;
      }
      const contextMatch = CONTEXT_DIRECTIVE.exec(stripped);
      if (contextMatch) {
        if (contextSeen) {
          throw new GuideCompileError(`Guide excerpt ${title} repeats its Context directive`);
        }
        contextLines = Number(contextMatch[1]);
        contextSeen = true;
        if (contextLines < 0 || contextLines > 8) {
          throw new GuideCompileError(`Guide excerpt ${title} Context must be between 0 and 8`);
        }
        continue;
      }
      const commentMatch = COMMENT_DIRECTIVE.exec(stripped);
      if (commentMatch) {
        const sideToken = commentMatch[1];
        const lineToken = commentMatch[2];
        const body = commentMatch[3];
        if (Number(lineToken) < 1 || !body.trim()) {
          throw new GuideCompileError(
            `Guide excerpt ${title} Comment needs a positive line and non-empty body`,
          );
        }
        const side: LineSide = sideToken === "L" ? "deletions" : "additions";
        comments.push([lineRef(side, Number(lineToken)), body.trim()]);
        continue;
      }
      if (
        stripped.startsWith("- Diff:") ||
        stripped.startsWith("- Context:") ||
        stripped.startsWith("- Comment:")
      ) {
        const directive = removePrefix(stripped.split(":")[0], "- ");
        throw new GuideCompileError(
          `Guide excerpt ${title} has invalid ${directive} directive syntax`,
        );
      }
    }
    explanationLines.push(rawLine);
  }

  if (inFence) throw new GuideCompileError(`Guide excerpt ${title} has an unterminated code fence`);
  if (!localId)
    throw new GuideCompileError(`Guide excerpt ${title} needs exactly one Diff directive`);
  if (!groupPaths.has(path)) {
    throw new GuideCompileError(
      `Guide excerpt ${localId} references a file outside review group ${groupId}: ${path}`,
    );
  }
  if (!diffByPath.has(path) || !patchByPath.has(path)) {
    throw new GuideCompileError(
      `Guide excerpt ${localId} references a file missing from the patch: ${path}`,
    );
  }
  const explanation = parseExplanationBlocks(explanationLines, `Guide excerpt ${localId}`);
  const refs = parseSelector(target, `Guide excerpt ${localId}`);
  const indexed = patchByPath.get(path) as IndexedPatchFile;
  const diffFile = diffByPath.get(path) as DiffFileSummary;
  const isGenerated = Boolean(diffFile.generated);
  const isBinary = Boolean(diffFile.binary);
  const changedRefs = indexed.changedRefs;

  if (isGenerated || isBinary) {
    if (phaseId !== "generated" || refs !== null) {
      throw new GuideCompileError(
        `Guide excerpt ${localId} must place generated/binary file ${path} as one whole-file item in Generated output`,
      );
    }
  } else if (changedRefs.size === 0) {
    if (phaseId !== "misc" || refs !== null) {
      throw new GuideCompileError(
        `Guide excerpt ${localId} must place zero-line file ${path} as one whole-file item in Imports, formatting, and miscellaneous`,
      );
    }
  } else if (refs === null) {
    throw new GuideCompileError(
      `Guide excerpt ${localId} must select exact changed lines for ${path}`,
    );
  } else if (phaseId === "generated") {
    throw new GuideCompileError(
      `Guide excerpt ${localId} may place only generated or binary files in Generated output`,
    );
  }

  let excerptPatch: string;
  let additions: number;
  let deletions: number;
  let visible: Set<string>;
  let coveredRefs: Set<string>;
  if (refs !== null) {
    const unknown = difference(refs.map(refKey), changedRefs);
    if (unknown.size > 0) {
      throw new GuideCompileError(
        `Guide excerpt ${localId} selects unchanged or missing lines: ${formatRefTokens(unknown)}`,
      );
    }
    const [synthesized, synthesizedVisible] = synthesizePatch(indexed, refs, contextLines);
    excerptPatch = synthesized;
    visible = synthesizedVisible;
    additions = refs.filter((ref) => ref.side === "additions").length;
    deletions = refs.filter((ref) => ref.side === "deletions").length;
    coveredRefs = new Set(refs.map(refKey));
  } else {
    excerptPatch = indexed.originalPatch;
    additions = diffFile.additions ?? 0;
    deletions = diffFile.deletions ?? 0;
    const allRows: PatchRow[] = [];
    for (const hunk of indexed.hunks) for (const row of hunk.rows) allRows.push(row);
    visible = visibleRefs(allRows);
    coveredRefs = new Set(changedRefs);
  }

  if (refs === null && comments.length > 0) {
    throw new GuideCompileError(`Guide excerpt ${localId} may not annotate a whole-file item`);
  }
  const commentAnchors = comments.map(([anchor]) => refKey(anchor));
  if (new Set(commentAnchors).size !== commentAnchors.length) {
    throw new GuideCompileError(`Guide excerpt ${localId} repeats a line comment anchor`);
  }
  const unknownAnchors = difference(commentAnchors, visible);
  if (unknownAnchors.size > 0) {
    throw new GuideCompileError(
      `Guide excerpt ${localId} comments on lines outside its rendered patch: ${formatRefTokens(
        unknownAnchors,
      )}`,
    );
  }

  const excerptId = `${groupId}/${localId}`;
  const compiledComments: GuideComment[] = comments.map(([anchor, body]) => {
    const sideToken = anchor.side === "deletions" ? "L" : "R";
    return {
      id: `${excerptId}/comment/${sideToken}${String(anchor.lineNumber)}`,
      side: anchor.side,
      lineNumber: anchor.lineNumber,
      body,
    };
  });
  const countsTowardCompletion = !isGenerated && !isBinary;
  return [
    {
      id: excerptId,
      title,
      explanation,
      path,
      url: diffFile.url ?? "",
      patch: excerptPatch,
      rangeLabel: formatRangeLabel(refs),
      additions,
      deletions,
      binary: isBinary,
      generated: isGenerated,
      countsTowardCompletion,
      defaultCollapsed: isGenerated || isBinary || phaseId === "misc" || phaseId === "generated",
      comments: compiledComments,
    },
    coveredRefs,
  ];
}

/** Compile one required Guide block and prove exact patch coverage. */
export function compileGuide(
  guideLines: string[],
  options: {
    groupId: string;
    groupPaths: Set<string>;
    diffFiles: DiffFileSummary[];
    patch: string;
  },
): { phases: GuidePhase[] } {
  const { groupId, groupPaths, diffFiles, patch } = options;
  const [prelude, phaseSections] = splitSections(guideLines, PHASE_HEADING, `Guide for ${groupId}`);
  if (prelude.some((line) => line.trim())) {
    throw new GuideCompileError(
      `Guide for ${groupId} may not contain content before its first phase`,
    );
  }
  if (phaseSections.length === 0) {
    throw new GuideCompileError(`Guide for ${groupId} needs at least one phase`);
  }

  const diffByPath = new Map<string, DiffFileSummary>();
  for (const item of diffFiles) diffByPath.set(item.path, item);
  const patchByPath = indexPatch(patch);
  const phases: GuidePhase[] = [];
  const seenPhaseTitles = new Set<string>();
  const seenExcerptIds = new Set<string>();
  const coveredByPath = new Map<string, Set<string>>();
  const wholeFileCounts = new Map<string, number>();
  for (const path of groupPaths) {
    coveredByPath.set(path, new Set<string>());
    wholeFileCounts.set(path, 0);
  }
  let previousPhaseIndex = -1;

  for (const [phaseTitle, phaseLines] of phaseSections) {
    const entry = PHASE_BY_TITLE.get(phaseTitle);
    if (!entry) {
      const allowed = PHASES.map(([, title]) => title).join(", ");
      throw new GuideCompileError(
        `Guide for ${groupId} has unsupported phase '${phaseTitle}'; use one of: ${allowed}`,
      );
    }
    if (seenPhaseTitles.has(phaseTitle)) {
      throw new GuideCompileError(`Guide for ${groupId} repeats phase ${phaseTitle}`);
    }
    const [phaseIndex, phaseId] = entry;
    if (phaseIndex <= previousPhaseIndex) {
      throw new GuideCompileError(`Guide for ${groupId} phases must follow the canonical order`);
    }
    previousPhaseIndex = phaseIndex;
    seenPhaseTitles.add(phaseTitle);

    const [phaseWithoutDiagram, diagram] = extractDiagram(
      phaseLines,
      `Guide phase ${phaseTitle} in ${groupId}`,
    );
    const [phasePrelude, excerptSections] = splitSections(
      phaseWithoutDiagram,
      EXCERPT_HEADING,
      `Guide phase ${phaseTitle} in ${groupId}`,
    );
    if (excerptSections.length === 0) {
      throw new GuideCompileError(
        `Guide phase ${phaseTitle} in ${groupId} needs at least one excerpt`,
      );
    }
    const explanation = parseExplanationBlocks(
      phasePrelude,
      `Guide phase ${phaseTitle} in ${groupId}`,
    );

    const compiledExcerpts: GuideExcerpt[] = [];
    for (const [excerptTitle, excerptLines] of excerptSections) {
      const [excerpt, coveredRefs] = parseExcerpt(excerptTitle, excerptLines, {
        groupId,
        phaseId,
        groupPaths,
        diffByPath,
        patchByPath,
      });
      const excerptId = excerpt.id;
      if (seenExcerptIds.has(excerptId)) {
        const localId = excerptId.slice(excerptId.lastIndexOf("/") + 1);
        throw new GuideCompileError(`Guide for ${groupId} repeats excerpt ID ${localId}`);
      }
      seenExcerptIds.add(excerptId);
      const path = excerpt.path;
      if (excerpt.rangeLabel === "Whole file") {
        wholeFileCounts.set(path, (wholeFileCounts.get(path) ?? 0) + 1);
      }
      const covered = coveredByPath.get(path) as Set<string>;
      const overlap = intersection(covered, coveredRefs);
      if (overlap.size > 0) {
        throw new GuideCompileError(
          `Guide for ${groupId} covers changed lines more than once in ${path}: ${formatRefTokens(
            overlap,
          )}`,
        );
      }
      for (const key of coveredRefs) covered.add(key);
      compiledExcerpts.push(excerpt);
    }

    const phase: GuidePhase = {
      id: phaseId,
      title: phaseTitle,
      explanation,
      excerpts: compiledExcerpts,
      defaultCollapsed: phaseId === "misc" || phaseId === "generated",
    };
    if (diagram !== null) phase.diagram = diagram;
    phases.push(phase);
  }

  for (const path of [...groupPaths].toSorted(compareStrings)) {
    const diffFile = diffByPath.get(path);
    const indexed = patchByPath.get(path);
    if (!diffFile || !indexed) {
      throw new GuideCompileError(
        `Guide for ${groupId} cannot validate missing patch file ${path}`,
      );
    }
    const specialWholeFile = Boolean(
      diffFile.generated || diffFile.binary || indexed.changedRefs.size === 0,
    );
    if (specialWholeFile) {
      if (wholeFileCounts.get(path) !== 1) {
        throw new GuideCompileError(
          `Guide for ${groupId} must cover ${path} with exactly one whole-file item`,
        );
      }
      continue;
    }
    const covered = coveredByPath.get(path) as Set<string>;
    const missing = difference(indexed.changedRefs, covered);
    const extra = difference(covered, indexed.changedRefs);
    if (missing.size > 0 || extra.size > 0) {
      const parts: string[] = [];
      if (missing.size > 0) parts.push(`missing ${formatRefTokens(missing)}`);
      if (extra.size > 0) parts.push(`unknown ${formatRefTokens(extra)}`);
      throw new GuideCompileError(
        `Guide for ${groupId} does not exactly cover ${path}: ${parts.join("; ")}`,
      );
    }
  }
  return { phases };
}
