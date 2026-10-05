import { formatPatch, structuredPatch } from "diff";
import type {
  ReviewDiffFileWire,
  ReviewDiffLens,
  ReviewDiffSide,
} from "../../shared/vendor/review-protocol/src/index.ts";

/**
 * File-side resolution, lens file filtering and the changed-file tree.
 * bb owns the rendered source and diff behavior (design §0.1).
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

/**
 * A single-file patch. Peeks retain only hunks intersecting their authored ranges.
 * `firstChangedLine` is the head line of the first change, where Open file lands.
 */
export function sourcePatch(input: {
  file: ReviewDiffFileWire;
  base: string;
  head: string;
  ranges?: readonly SourceRange[];
}): { text: string; firstChangedLine: number } | undefined {
  const { file, base, head, ranges } = input;
  const patch = structuredPatch(
    file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`,
    file.status === "deleted" ? "/dev/null" : `b/${file.path}`,
    base,
    head,
    undefined,
    undefined,
    { context: 3 },
  );
  patch.isGit = true;
  patch.isRename = Boolean(file.previousPath);
  patch.isCreate = file.status === "added";
  patch.isDelete = file.status === "deleted";
  if (ranges?.length)
    patch.hunks = patch.hunks.filter((hunk) =>
      ranges.some((range) => {
        const start = range.side === "base" ? hunk.oldStart : hunk.newStart;
        const count = range.side === "base" ? hunk.oldLines : hunk.newLines;
        return range.fromLine <= start + Math.max(1, count) - 1 && range.toLine >= start;
      }),
    );
  const [first] = patch.hunks;
  if (!first) return undefined;
  const context = first.lines.findIndex((line) => !line.startsWith(" "));
  return {
    text: formatPatch(patch),
    firstChangedLine: Math.max(1, first.newStart + Math.max(0, context)),
  };
}

/**
 * Context-only hunks over a peek's ranges ±3 lines, as upstream's lens window.
 * Overlapping or adjacent windows merge. bb's Diff keeps real line numbers and
 * folds the rest of the file into its own expanders. `undefined` when every
 * range starts past the end of the file.
 */
export function contextPatch(input: {
  path: string;
  content: string;
  ranges: readonly { fromLine: number; toLine: number }[];
}): string | undefined {
  const lines = input.content.split("\n");
  const finalNewline = lines.at(-1) === "";
  if (finalNewline) lines.pop();
  const windows: { start: number; end: number }[] = [];
  for (const range of input.ranges
    .filter((item) => item.fromLine <= lines.length)
    .sort((left, right) => left.fromLine - right.fromLine)) {
    const start = Math.max(1, range.fromLine - 3);
    const end = Math.min(lines.length, range.toLine + 3);
    const last = windows.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  if (!windows.length) return undefined;
  return formatPatch({
    oldFileName: `a/${input.path}`,
    newFileName: `b/${input.path}`,
    oldHeader: undefined,
    newHeader: undefined,
    isGit: true,
    hunks: windows.map(({ start, end }) => {
      const body = lines.slice(start - 1, end).map((line) => ` ${line}`);
      if (end === lines.length && !finalNewline) body.push("\\ No newline at end of file");
      const count = end - start + 1;
      return { oldStart: start, oldLines: count, newStart: start, newLines: count, lines: body };
    }),
  });
}
