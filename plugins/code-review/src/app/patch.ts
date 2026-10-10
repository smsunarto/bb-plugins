import { getSingularPatch } from "@pierre/diffs";
import type { AnnotationSide, DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { ChangedFile, DiffSide, Finding, ReviewThread } from "../shared/schema.ts";

/*
 * The seam between GitHub's review model and Pierre's diff model. GitHub
 * places a review comment by file line and side (LEFT is the base, RIGHT the
 * head). Pierre places an annotation by line and "deletions" or "additions",
 * so the two meet on (side, line). Nothing here touches the DOM.
 */

/**
 * GitHub's per-file `patch` is bare hunks. Pierre reads a git patch, and takes
 * the file's name, and whether it was added or deleted, from the header, so
 * this writes the header git would have. Null when GitHub sent no hunks:
 * binary files, files too large to diff, and pure renames.
 */
export function gitPatch(
  file: Pick<ChangedFile, "path" | "previousPath" | "status" | "patch">,
): string | null {
  if (!file.patch) return null;
  const oldPath = file.previousPath ?? file.path;
  const header = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.status === "added") {
    header.push("new file mode 100644", "--- /dev/null", `+++ b/${file.path}`);
  } else if (file.status === "removed") {
    header.push("deleted file mode 100644", `--- a/${file.path}`, "+++ /dev/null");
  } else {
    if (file.status === "renamed" && file.previousPath) {
      // Pierre reads a rename off the similarity line, and only tells 100%
      // (a pure rename) from the rest. A file with hunks is never 100%.
      header.push(
        "similarity index 50%",
        `rename from ${file.previousPath}`,
        `rename to ${file.path}`,
      );
    }
    header.push(`--- a/${oldPath}`, `+++ b/${file.path}`);
  }
  const body = file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`;
  return `${header.join("\n")}\n${body}`;
}

/**
 * The file's diff, ready for `FileDiff`. Null when there is nothing to draw.
 * The cache key is the patch text itself, as in `plugins/gitbutler`: a new
 * push that changes the file gets a new highlight, the same text shares one.
 */
export function parseFilePatch(
  file: Pick<ChangedFile, "path" | "previousPath" | "status" | "patch">,
): FileDiffMetadata | null {
  const text = gitPatch(file);
  if (!text) return null;
  try {
    return { ...getSingularPatch(text), cacheKey: `code-review:${text}` };
  } catch {
    return null;
  }
}

/**
 * The rows Pierre draws for a diff: each hunk's lines, and a separator above
 * each hunk with unchanged lines before it. The diff's own `unifiedLineCount`
 * and `splitLineCount` count those unchanged lines too, but a diff read from
 * a patch only has the hunks, so it folds them and never draws them.
 */
export function drawnRows(
  parsed: FileDiffMetadata,
  diffStyle: "unified" | "split",
): { lines: number; separators: number } {
  let lines = 0;
  let separators = 0;
  for (const hunk of parsed.hunks) {
    lines += diffStyle === "split" ? hunk.splitLineCount : hunk.unifiedLineCount;
    if (hunk.collapsedBefore > 0) separators++;
  }
  return { lines, separators };
}

export function toAnnotationSide(side: DiffSide): AnnotationSide {
  return side === "LEFT" ? "deletions" : "additions";
}

/** Pierre leaves the side off a selection in places; a bare line is the head's. */
export function toDiffSide(side: AnnotationSide | undefined): DiffSide {
  return side === "deletions" ? "LEFT" : "RIGHT";
}

type Position = {
  /** Row in the unified diff, top to bottom. A context line is one row on both sides. */
  row: number;
  hunk: number;
};

/**
 * Every line a review comment can sit on: each line inside a hunk, on the
 * side it exists on. Context lines exist on both. Lines between hunks are not
 * in the patch, and GitHub rejects comments on them.
 */
export type DiffLines = ReadonlyMap<string, Position>;

const lineKey = (side: DiffSide, line: number) => `${side}:${line}`;

export function diffLines(parsed: FileDiffMetadata): DiffLines {
  const lines = new Map<string, Position>();
  let row = 0;
  parsed.hunks.forEach((hunk, index) => {
    let left = hunk.deletionStart;
    let right = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let i = 0; i < content.lines; i++) {
          lines.set(lineKey("LEFT", left++), { row, hunk: index });
          lines.set(lineKey("RIGHT", right++), { row: row++, hunk: index });
        }
        continue;
      }
      for (let i = 0; i < content.deletions; i++) {
        lines.set(lineKey("LEFT", left++), { row: row++, hunk: index });
      }
      for (let i = 0; i < content.additions; i++) {
        lines.set(lineKey("RIGHT", right++), { row: row++, hunk: index });
      }
    }
  });
  return lines;
}

export function isCommentable(lines: DiffLines, side: DiffSide, line: number): boolean {
  return lines.has(lineKey(side, line));
}

/** Where a new comment goes, in `addDraftComment`'s terms. */
export type CommentTarget = {
  line: number;
  side: DiffSide;
  /** First line of a multi-line comment. Null for one line. */
  startLine: number | null;
  startSide: DiffSide | null;
};

/** The part of Pierre's `SelectedLineRange` a comment needs. */
export type LineRange = {
  start: number;
  end: number;
  side?: AnnotationSide;
  endSide?: AnnotationSide;
};

/**
 * The comment a gutter click or line selection asks for. Pierre reports the
 * range in the order it was dragged, so this puts it top to bottom. GitHub
 * wants a multi-line comment inside one hunk, so a range that crosses hunks
 * comments on its last line alone. Null when neither end is in the diff.
 */
export function commentTarget(lines: DiffLines, range: LineRange): CommentTarget | null {
  const first = { side: toDiffSide(range.side), line: range.start };
  const last = { side: toDiffSide(range.endSide ?? range.side), line: range.end };
  const firstAt = lines.get(lineKey(first.side, first.line));
  const lastAt = lines.get(lineKey(last.side, last.line));
  if (!firstAt || !lastAt) {
    const only = lastAt ? last : firstAt ? first : null;
    return only ? { ...only, startLine: null, startSide: null } : null;
  }
  const [start, end] = firstAt.row <= lastAt.row ? [first, last] : [last, first];
  if (firstAt.row === lastAt.row || firstAt.hunk !== lastAt.hunk) {
    return { ...end, startLine: null, startSide: null };
  }
  return { line: end.line, side: end.side, startLine: start.line, startSide: start.side };
}

/** What an annotation row holds. */
export type AnnotationData =
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "finding"; finding: Finding }
  /** The new-comment form, with the head its lines were picked in. */
  | { kind: "composer"; target: CommentTarget; headRefOid: string };

export type Annotation = DiffLineAnnotation<AnnotationData>;

function annotationAt(side: DiffSide, line: number, metadata: AnnotationData): Annotation {
  // Pierre's type spreads a union of metadata into a union of annotations,
  // which one annotation holding the union does not satisfy on its own.
  return { side: toAnnotationSide(side), lineNumber: line, metadata } as Annotation;
}

/**
 * Review threads as inline annotations, in GitHub's order, so a new thread
 * lands after the ones already drawn. File-level threads have no line.
 * Outdated threads, and any thread whose line this patch does not show, have
 * no row to sit on; both are listed under the file header instead.
 */
export function placeThreads(
  threads: readonly ReviewThread[],
  lines: DiffLines,
): { annotations: Annotation[]; outdated: ReviewThread[]; fileLevel: ReviewThread[] } {
  const annotations: Annotation[] = [];
  const outdated: ReviewThread[] = [];
  const fileLevel: ReviewThread[] = [];
  for (const thread of threads) {
    if (thread.isFileLevel) fileLevel.push(thread);
    else if (
      thread.isOutdated ||
      thread.line === null ||
      !isCommentable(lines, thread.side, thread.line)
    ) {
      outdated.push(thread);
    } else annotations.push(annotationAt(thread.side, thread.line, { kind: "thread", thread }));
  }
  return { annotations, outdated, fileLevel };
}

/**
 * bb findings as inline annotations. A finding can name a line the diff
 * leaves out, unchanged code the change breaks, and those are listed under
 * the file header instead.
 */
export function placeFindings(
  findings: readonly Finding[],
  lines: DiffLines,
): { annotations: Annotation[]; elsewhere: Finding[] } {
  const annotations: Annotation[] = [];
  const elsewhere: Finding[] = [];
  for (const finding of findings) {
    if (isCommentable(lines, finding.side, finding.line)) {
      annotations.push(annotationAt(finding.side, finding.line, { kind: "finding", finding }));
    } else elsewhere.push(finding);
  }
  return { annotations, elsewhere };
}

export function composerAnnotation(target: CommentTarget, headRefOid: string): Annotation {
  return annotationAt(target.side, target.line, { kind: "composer", target, headRefOid });
}

/** The DOM id of a file's card in the Changes tab. Unique per path, and free of spaces. */
export function fileAnchorId(path: string): string {
  return `cr-file-${encodeURIComponent(path)}`;
}

/** The file on GitHub's Files changed page, which anchors each file by its path's SHA-256. */
export async function githubFileUrl(prUrl: string, path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prUrl}/files#diff-${hex}`;
}
