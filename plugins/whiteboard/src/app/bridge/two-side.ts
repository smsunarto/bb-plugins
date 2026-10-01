import type {
  ReviewDiffFileWire,
  ReviewDiffLens,
  ReviewDiffProgressFile,
  ReviewDiffSide,
} from "../../shared/vendor/review-protocol/src/index.ts";

/**
 * The two-sided model behind every bb code surface (design §1.5, §1.6).
 *
 * Ported from the Whiteboard Desktop host (dev.fast, MIT), which this plugin
 * replaces: `reviewApiSourceService.ts` (which revision a side reads),
 * `common/reviewLens.ts` (alignment rows, lens and viewed folds),
 * `common/reviewLensFiles.ts` and `common/reviewChangedFilesModel.ts`.
 * Monaco's diff editor is replaced by `@pierre/diffs`, so the fold model is
 * computed here and rendered as segments and gap bars by `diff-view.tsx`.
 */

export type SourceRange = ReviewDiffLens["ranges"][number];

/** Which file and revision a side reads, across add/delete/rename. `null`: the side does not exist. */
export function resolveSide(input: {
  path: string;
  previousPath?: string;
  side: ReviewDiffSide;
  status?: string;
}): { path: string; side: ReviewDiffSide } | null {
  if (input.side === "base") {
    if (input.status === "added") return null;

    return { path: input.previousPath ?? input.path, side: "base" };
  }

  if (input.status === "deleted") return null;

  return { path: input.path, side: "head" };
}

/** The path a lens range names for this file on its side. */
export function sidePath(file: ReviewDiffFileWire, side: ReviewDiffSide): string {
  return side === "base" ? (file.previousPath ?? file.path) : file.path;
}

/** The lens ranges that fall in one file (`reviewLens.ts` `lensRanges`). */
export function lensRangesFor(
  ranges: readonly SourceRange[],
  file: ReviewDiffFileWire,
): SourceRange[] {
  return ranges.filter((range) => range.file === sidePath(file, range.side));
}

/** Diagram evidence may name files outside the comparison; they join as unchanged context. */
export function lensFiles(
  files: readonly ReviewDiffFileWire[],
  lens?: ReviewDiffLens,
): readonly ReviewDiffFileWire[] {
  if (!lens || lens.wholeFiles) return files;
  const known = new Set(
    files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]),
  );
  const context: ReviewDiffFileWire[] = [];

  for (const range of lens.ranges) {
    if (known.has(range.file)) continue;
    known.add(range.file);
    context.push({ path: range.file, status: "unchanged", additions: 0, deletions: 0 });
  }

  return [...files, ...context];
}

export type ChangedTreeElement =
  | { kind: "file"; file: ReviewDiffFileWire; name: string }
  | { kind: "folder"; name: string; path: string; children: ChangedTreeElement[] };

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: Extract<ChangedTreeElement, { kind: "file" }>[];
}

/** Folders first, then files, each by name (`reviewChangedFilesModel.ts`). */
export function buildChangedTree(files: readonly ReviewDiffFileWire[]): ChangedTreeElement[] {
  const root: MutableFolder = { name: "", path: "", folders: new Map(), files: [] };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    const name = segments.pop() ?? file.path;
    let folder = root;

    for (const segment of segments) {
      const path = folder.path ? `${folder.path}/${segment}` : segment;
      let child = folder.folders.get(segment);

      if (!child) {
        child = { name: segment, path, folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push({ kind: "file", file, name });
  }

  const children = (folder: MutableFolder): ChangedTreeElement[] => [
    ...[...folder.folders.values()]
      .map((child): ChangedTreeElement => ({
        kind: "folder",
        name: child.name,
        path: child.path,
        children: children(child),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    ...[...folder.files].sort((left, right) => left.name.localeCompare(right.name)),
  ];

  return children(root);
}

/** Changed files in the order the tree shows them. */
export function orderDiffFiles(files: readonly ReviewDiffFileWire[]): ReviewDiffFileWire[] {
  const ordered: ReviewDiffFileWire[] = [];
  const collect = (elements: readonly ChangedTreeElement[]) => {
    for (const element of elements)
      if (element.kind === "file") ordered.push(element.file);
      else collect(element.children);
  };

  collect(buildChangedTree(files));

  return ordered;
}

// ---------------------------------------------------------------- rows

/** One alignment row: 0-based line indexes on each side, `null` where a side has no line. */
export interface AlignedRow {
  base: number | null;
  head: number | null;
  changed: boolean;
}

/** The shape `parseDiffFromFile` returns for full contents (`isPartial: false`). */
export interface FullFileDiff {
  deletionLines: readonly string[];
  additionLines: readonly string[];
  hunks: readonly {
    collapsedBefore: number;
    hunkContent: readonly (
      | { type: "context"; lines: number }
      | { type: "change"; deletions: number; additions: number }
    )[];
  }[];
}

/**
 * The full row table, like `alignmentRows` in `reviewLens.ts`: unchanged
 * lines pair across sides, and a change block zips its deleted and added
 * lines row by row.
 */
export function alignRows(diff: FullFileDiff): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let base = 0;
  let head = 0;
  const context = (count: number) => {
    for (let index = 0; index < count; index++)
      rows.push({ base: base++, head: head++, changed: false });
  };

  for (const hunk of diff.hunks) {
    context(hunk.collapsedBefore);

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        context(content.lines);
        continue;
      }
      const deletions = base + content.deletions;
      const additions = head + content.additions;

      while (base < deletions || head < additions)
        rows.push({
          base: base < deletions ? base++ : null,
          head: head < additions ? head++ : null,
          changed: true,
        });
    }
  }

  // Trailing unchanged lines. A one-sided remainder cannot be context.
  while (base < diff.deletionLines.length || head < diff.additionLines.length) {
    const paired = base < diff.deletionLines.length && head < diff.additionLines.length;

    rows.push({
      base: base < diff.deletionLines.length ? base++ : null,
      head: head < diff.additionLines.length ? head++ : null,
      changed: !paired,
    });
  }

  return rows;
}

function inRanges(
  ranges: readonly Pick<SourceRange, "side" | "fromLine" | "toLine">[],
  row: AlignedRow,
): boolean {
  return ranges.some((range) => {
    const line = range.side === "base" ? row.base : row.head;

    return line !== null && line + 1 >= range.fromLine && line + 1 <= range.toLine;
  });
}

/** Rows a lens keeps: its ranges plus 3 alignment rows of context (`lensContextGaps`). */
export function lensContext(
  rows: readonly AlignedRow[],
  ranges: readonly Pick<SourceRange, "side" | "fromLine" | "toLine">[],
): boolean[] {
  const visible = rows.map((row) => inRanges(ranges, row));

  return visible.map((_, index) => visible.slice(Math.max(0, index - 3), index + 4).some(Boolean));
}

/** A paired row folds only when none of its changed lines remain unread (`viewedContextGaps`). */
export function viewedRows(
  rows: readonly AlignedRow[],
  viewed: readonly SourceRange[],
  changed: readonly SourceRange[],
): boolean[] {
  const contains = (ranges: readonly SourceRange[], side: ReviewDiffSide, line: number) =>
    ranges.some(
      (range) => range.side === side && line + 1 >= range.fromLine && line + 1 <= range.toLine,
    );

  return rows.map((row) => {
    const sides = [
      ["base", row.base],
      ["head", row.head],
    ] as const;

    return (
      sides.some(([side, line]) => line !== null && contains(viewed, side, line)) &&
      sides.every(
        ([side, line]) =>
          line === null || !contains(changed, side, line) || contains(viewed, side, line),
      )
    );
  });
}

export type GapLabel = "Outside lens" | "Viewed" | "Unchanged";

/** Rows `[start, end)` folded behind one gap bar. An uncollapsed gap is unfolded by default. */
export interface Gap {
  start: number;
  end: number;
  label: GapLabel;
  collapsed: boolean;
}

function runs(hidden: readonly boolean[], label: GapLabel, minimum = 1): Gap[] {
  const gaps: Gap[] = [];

  for (let index = 0; index < hidden.length;) {
    if (!hidden[index]) {
      index++;
      continue;
    }
    const start = index;

    while (index < hidden.length && hidden[index]) index++;

    if (index - start >= minimum) gaps.push({ start, end: index, label, collapsed: true });
  }

  return gaps;
}

const overlaps = (left: Gap, right: Gap) => left.start < right.end && right.start < left.end;

/** Keep `kept`, plus each of `others` that does not overlap them (upstream keeps provider folds this way). */
function layer(kept: Gap[], others: readonly Gap[]): Gap[] {
  return [...kept, ...others.filter((gap) => !kept.some((hidden) => overlaps(gap, hidden)))].sort(
    (left, right) => left.start - right.start,
  );
}

/**
 * The folds of one file, in the order `withLens` (`services/reviewLens.ts`)
 * applies them: unchanged context when no lens filters rows, then viewed
 * rows, then reader unfolds, then the lens.
 * Without progress or lens, Monaco's default unchanged-region hiding
 * applies (3 lines of context, 3 lines minimum).
 */
export function foldGaps(
  rows: readonly AlignedRow[],
  options: {
    /** Ranges for this file. Absent: no lens, or a whole-files lens. */
    lens?: readonly SourceRange[];
    progress?: Pick<ReviewDiffProgressFile, "viewedRanges" | "changedRanges" | "unfoldRanges">;
  },
): Gap[] {
  const { lens, progress } = options;
  let gaps: Gap[] = [];

  if (progress) {
    if (!lens)
      gaps = runs(
        lensContext(rows, progress.changedRanges).map((visible) => !visible),
        "Unchanged",
      );
    gaps = layer(
      runs(viewedRows(rows, progress.viewedRanges, progress.changedRanges), "Viewed"),
      gaps,
    );

    if (progress.unfoldRanges?.length) {
      const unfolded = progress.unfoldRanges;

      gaps = gaps.map((gap) =>
        rows.slice(gap.start, gap.end).some((row) => inRanges(unfolded, row))
          ? { ...gap, collapsed: false }
          : gap,
      );
    }
  } else if (!lens) {
    const changes = rows.map((row) => row.changed);
    const near = changes.map((_, index) =>
      changes.slice(Math.max(0, index - 3), index + 4).some(Boolean),
    );

    gaps = runs(
      near.map((visible) => !visible),
      "Unchanged",
      3,
    );
  }

  if (lens)
    gaps = layer(
      runs(
        lensContext(rows, lens).map((visible) => !visible),
        "Outside lens",
      ),
      gaps,
    );

  return gaps;
}

export type Segment =
  | { kind: "rows"; start: number; end: number }
  | { kind: "gap"; start: number; end: number; label: GapLabel };

/** Visible row runs and the gap bars between them. `expanded` holds gap starts the reader opened. */
export function segments(
  rowCount: number,
  gaps: readonly Gap[],
  expanded: ReadonlySet<number> = new Set(),
): Segment[] {
  const hidden = gaps.filter((gap) => gap.collapsed && !expanded.has(gap.start));
  const out: Segment[] = [];
  let cursor = 0;

  for (const gap of hidden) {
    if (gap.start > cursor) out.push({ kind: "rows", start: cursor, end: gap.start });
    out.push({ kind: "gap", start: gap.start, end: gap.end, label: gap.label });
    cursor = gap.end;
  }

  if (cursor < rowCount) out.push({ kind: "rows", start: cursor, end: rowCount });

  return out;
}

/** The row that holds a side's 1-based line. */
export function rowOfLine(rows: readonly AlignedRow[], side: ReviewDiffSide, line: number): number {
  return rows.findIndex((row) => (side === "base" ? row.base : row.head) === line - 1);
}

// ---------------------------------------------------------------- texts

/** A side's text split into lines, without line terminators, and whether it ends with one. */
export interface SideText {
  lines: string[];
  /** `false` when the text is non-empty and lacks a final newline. */
  eol: boolean;
}

export function sideText(text: string): SideText {
  if (!text) return { lines: [], eol: true };
  const eol = text.endsWith("\n");
  const lines = (eol ? text.slice(0, -1) : text).split("\n").map((line) => line.replace(/\r$/, ""));

  return { lines, eol };
}

/**
 * One unified-diff hunk for rows `[start, end)`, with true line numbers, for
 * `@pierre/diffs` `getSingularPatch`. Change rows emit their deletions
 * before their additions, as git does.
 */
export function segmentPatch(input: {
  path: string;
  rows: readonly AlignedRow[];
  base: SideText;
  head: SideText;
  start: number;
  end: number;
}): string {
  const { rows, base, head, start, end } = input;
  const before = (side: "base" | "head") => {
    let count = 0;

    for (let index = 0; index < start; index++) if (rows[index][side] !== null) count++;

    return count;
  };
  const lines: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  const line = (marker: string, side: SideText, index: number) => {
    lines.push(`${marker}${side.lines[index]}`);

    if (index === side.lines.length - 1 && !side.eol) lines.push("\\ No newline at end of file");
  };

  for (let index = start; index < end;) {
    const row = rows[index];

    if (!row.changed) {
      line(" ", head, row.head!);
      oldCount++;
      newCount++;
      index++;
      continue;
    }
    const deleted: number[] = [];
    const added: number[] = [];

    while (index < end && rows[index].changed) {
      if (rows[index].base !== null) deleted.push(rows[index].base!);

      if (rows[index].head !== null) added.push(rows[index].head!);
      index++;
    }

    for (const lineIndex of deleted) line("-", base, lineIndex);

    for (const lineIndex of added) line("+", head, lineIndex);
    oldCount += deleted.length;
    newCount += added.length;
  }
  const oldBefore = before("base");
  const newBefore = before("head");
  const oldStart = oldCount ? oldBefore + 1 : oldBefore;
  const newStart = newCount ? newBefore + 1 : newBefore;

  return `--- ${input.path}\n+++ ${input.path}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}\n`;
}
