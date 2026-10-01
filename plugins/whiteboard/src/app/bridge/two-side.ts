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

/** A single-file patch. Peeks retain only hunks intersecting their authored ranges. */
export function sourcePatch(input: {
  file: ReviewDiffFileWire;
  base: string;
  head: string;
  ranges?: readonly SourceRange[];
}): string | undefined {
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
  return patch.hunks.length ? formatPatch(patch) : undefined;
}
