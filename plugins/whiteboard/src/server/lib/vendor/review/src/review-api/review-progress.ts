// Vendored from dev.fast review/src/review-api/review-progress.ts @4ecc570 (MIT).
import { z } from "zod";

import {
  type LensSource,
  comparisonKey,
  resolveDiffSelection,
  selectionKey,
} from "../../../../../../shared/vendor/review/src/lens-selection.ts";
import { type FileLineRange, fileLineRangeSchema } from "../../../../../../shared/vendor/review/src/source.ts";
import { type CoverageFile, emptyCoverage } from "../../../../../../shared/vendor/review/src/viewed-coverage.ts";
import type { ComparisonCoverage } from "./comparison-coverage.ts";
import {
  type Lens,
  UNCATEGORIZED_LENS_ID,
  lensSelections,
} from "../../../../../../shared/vendor/review/src/review-api/diff-lenses.ts";
import { type Pins, anchorPins, selectionReferences } from "../../../../../../shared/vendor/review/src/review-api/document.ts";
import { ReviewInputError } from "../../../../../../shared/vendor/review/src/review-api/input-error.ts";
import { textualRows } from "../../../../../../shared/vendor/review/src/review-api/lens-alignment.ts";
import { resolveFileLens, uncategorizedSources } from "./file-lenses.ts";
import type { LocalReviewData } from "./local-data.ts";
import type { ReviewStore, Snapshot } from "./store.ts";

export const coverageModeSchema = z
  .enum(["structural", "textual"])
  .default("structural");

export const progressUpdateSchema = z.strictObject({
  mode: coverageModeSchema,
  version: z.number().int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        fingerprint: z.string().min(1),
        sources: z.array(fileLineRangeSchema),
      }),
    )
    .max(10000),
  viewed: z.boolean(),
});

/** How the Diff view lists a lens: resolved against complete coverage,
 * still resolving against partial coverage, or nothing to show. */
export type LensState =
  | {
      state: "ready" | "pending";
      sources: FileLineRange[];
      fileCount: number;
      wholeFiles?: boolean;
    }
  | { state: "unavailable"; reason: string };

export interface ReviewProgress {
  unavailableSelections?: Record<string, string>;
  files: CoverageFile[];
  /** Changed files of the comparisons that references with their own pins
   * named, by `comparisonKey` and then path. They are not the document's
   * comparison, so they are not in `files`; a node attached to one still
   * counts its changed lines, under its own pins only. A comparison that
   * changed nothing at a cited path has an entry with no file for it. */
  referenceFiles?: Record<string, Record<string, CoverageFile>>;
  resolvedSelections: Record<string, FileLineRange[]>;
  /** The review's file lenses, then the automatic "Uncategorized changes".
   * Coverage is complete once no lens is pending. */
  lenses: ({ id: string; title: string } & LensState)[];
}

/** Coverage survives new pins only when both complete file contents are unchanged. */
export async function reviewProgress(
  store: ReviewStore,
  data: LocalReviewData,
  snapshot: Snapshot,
  signal: AbortSignal = new AbortController().signal,
  mode: "structural" | "textual" = "structural",
  partial?: ComparisonCoverage,
): Promise<ReviewProgress> {
  // A shared review is read-only and never enters the store, so it has no
  // persisted marks to look up.
  const marks: ReturnType<ReviewStore["viewedCoverage"]> = snapshot.shared
    ? new Map()
    : store.viewedCoverage(snapshot.reviewId);

  const pins = snapshot.source
    ? (await data.resolveSource(snapshot)).pins
    : undefined;

  // A document without pins of its own has no changed files; its references
  // each resolve against the comparison their own pins name.
  const comparison: ComparisonCoverage = pins
    ? (partial ?? (await data.coverage(snapshot.reviewId, pins, mode)))
    : { files: [], fileSources: new Map(), alignments: new Map() };

  signal.throwIfAborted();

  const documentKey = JSON.stringify(pins);
  const comparisons = new Map<string, Promise<ComparisonCoverage>>();

  /** The comparison a reference's own pins name, shared across references. */
  const ownComparison = (
    own: Pins,
  ): Promise<ComparisonCoverage> | undefined => {
    const key = JSON.stringify(own);
    let loading = comparisons.get(key);

    if (loading) return loading;

    if (partial) {
      const state = data.coverageSnapshot(snapshot.reviewId, own, mode);

      if (state.pending) return undefined;
    }

    loading = data.coverage(snapshot.reviewId, own, mode);
    comparisons.set(key, loading);

    return loading;
  };

  const withViewed = (file: CoverageFile): CoverageFile => ({
    ...file,
    viewed:
      marks.get(file.path)?.fingerprint === file.fingerprint
        ? marks.get(file.path)!.coverage
        : emptyCoverage(),
  });

  const files = comparison.files.map(withViewed);
  const referenceFiles: Record<string, Record<string, CoverageFile>> = {};

  const fileSources = new Map(comparison.fileSources);
  const alignments = new Map(comparison.alignments);
  const resolvedSelections: Record<string, FileLineRange[]> = {};

  const unavailableSelections: Record<string, string> = {};
  const pendingSources = new Set<string>();

  const resolve = async (source: LensSource): Promise<FileLineRange[]> => {
    const key = selectionKey(source);

    if (resolvedSelections[key]) return resolvedSelections[key];
    const sourcePins = anchorPins(source, pins);
    const own = JSON.stringify(sourcePins) !== documentKey;
    let ownFiles = files;
    let ownAlignments = alignments;

    if (own) {
      const loading = ownComparison(sourcePins);

      if (!loading) {
        pendingSources.add(key);

        return [];
      }

      const loaded = await loading;
      ownFiles = loaded.files;
      ownAlignments = loaded.alignments;
    }

    const file = ownFiles.find(
      (file) => source.file === file.path || source.file === file.previousPath,
    );

    if (own) {
      const group = (referenceFiles[comparisonKey(sourcePins)] ??= {});

      if (file) group[file.path] ??= withViewed(file);
    }

    let rows = file && ownAlignments.get(file.path);

    // Context-only files are absent from the changed-file stream. Read both pins
    // and require equality rather than inventing correspondence for missing diffs.
    // A file present on only one side resolves against that side.
    if (!file && partial && !own) {
      pendingSources.add(key);

      return [];
    }

    if (!file) {
      const [base, head] = await Promise.all(
        (["base", "head"] as const).map((side) =>
          data.file(sourcePins, side, source.file).then(
            (value) => value.text,
            (error) => {
              if (error instanceof ReviewInputError && error.status === 404) return null;
              throw error;
            },
          ),
        ),
      );

      if (base === null && head === null) throw new Error("File is unavailable at these pins.");
      if (base !== null && head !== null && base !== head)
        throw new Error("Changed context file has no alignment.");
      rows = textualRows(
        source.file,
        "",
        base?.split("\n").length ?? 0,
        head?.split("\n").length ?? 0,
      );
    }

    if (!rows) throw new Error("File has no text alignment.");

    const result = resolveDiffSelection(
      source,
      rows,
      file ?? { path: source.file },
    );

    resolvedSelections[key] = result;

    return result;
  };

  const resolveAvailable = async (source: LensSource) => {
    try {
      return await resolve(source);
    } catch {
      unavailableSelections[selectionKey(source)] =
        "Source links need updating at these pins";

      return [];
    }
  };

  const lenses: ReviewProgress["lenses"] = await Promise.all(
    (snapshot.lenses ?? []).map(
      async (authored): Promise<ReviewProgress["lenses"][number]> => {
      const lens = { id: authored.id, title: authored.title };

      try {
        // Explicit ranges use the same pin validation as diagram evidence.
        await Promise.all(
          lensSelections([authored]).map(({ source }) =>
            resolveAvailable(source),
          ),
        );

        const resolved = resolveFileLens(
          authored,
          files,
          fileSources,
          (source) => resolvedSelections[selectionKey(source)] ?? [],
        );

        if (!partial && !resolved.fileCount)
          return {
            ...lens,
            state: "unavailable",
            reason: "No files match these targets",
          };

        return { ...lens, ...resolved, state: partial ? "pending" : "ready" };
      } catch {
        return {
          ...lens,
          state: "unavailable",
          reason: "Source links need updating at these pins",
        };
      }
      },
    ),
  );

  // Peeks share alignment resolution without claiming lens coverage.
  await Promise.all(
    selectionReferences(snapshot.document, { tolerant: true }).map(
      async ({ source }) => {
        try {
          await resolveAvailable(source);
        } catch {
          /* An unavailable peek does not hide other content. */
        }
      },
    ),
  );

  const uncategorized = partial
    ? []
    : uncategorizedSources(
        files,
        lenses.flatMap((lens) =>
          lens.state === "unavailable" ? [] : lens.sources,
        ),
      );

  const fileCount = new Set(
    uncategorized.map(
      (source) =>
        files.find(
          (file) =>
            source.file ===
            (source.side === "base"
              ? (file.previousPath ?? file.path)
              : file.path),
        )?.path ?? source.file,
    ),
  ).size;

  lenses.push({
    id: UNCATEGORIZED_LENS_ID,
    title: "Uncategorized changes",
    ...(partial
      ? { state: "pending", sources: [], wholeFiles: false, fileCount: 0 }
      : uncategorized.length
        ? { state: "ready", sources: uncategorized, wholeFiles: false, fileCount }
        : {
            state: "unavailable",
            reason: "All changed lines are covered by lenses",
          }),
  });

  return {
    files,
    referenceFiles,
    lenses,
    resolvedSelections,
    unavailableSelections,
  };
}

/** The most files an uncategorized report names; the rest are counted. */
const REPORT_FILES = 50;

export interface UncategorizedReport {
  /** Changed lines, counting each side, that no lens selects. */
  lines: number;
  files: {
    path: string;
    lines: number;
    ranges: Pick<FileLineRange, "side" | "fromLine" | "toLine">[];
  }[];
  /** Files past the first REPORT_FILES, left out of `files`. */
  moreFiles?: number;
}

/** What a lens author still has to place: the changed lines no lens selects,
 * grouped by file. */
export function uncategorizedReport(
  progress: ReviewProgress,
): UncategorizedReport {
  const uncategorized = progress.lenses.find(
    (lens) => lens.id === UNCATEGORIZED_LENS_ID,
  );
  const sources =
    uncategorized && uncategorized.state !== "unavailable"
      ? uncategorized.sources
      : [];

  const byPath = new Map<string, UncategorizedReport["files"][number]>();

  for (const source of sources) {
    const path =
      progress.files.find(
        (file) =>
          source.file ===
          (source.side === "base"
            ? (file.previousPath ?? file.path)
            : file.path),
      )?.path ?? source.file;

    const entry = byPath.get(path) ?? { path, lines: 0, ranges: [] };
    entry.lines += source.toLine - source.fromLine + 1;
    entry.ranges.push({
      side: source.side,
      fromLine: source.fromLine,
      toLine: source.toLine,
    });
    byPath.set(path, entry);
  }

  const files = [...byPath.values()];

  const report: UncategorizedReport = {
    lines: files.reduce((total, file) => total + file.lines, 0),
    files: files.slice(0, REPORT_FILES),
  };

  if (files.length > REPORT_FILES)
    report.moreFiles = files.length - REPORT_FILES;

  return report;
}

/** Each lens as authored, with what it resolves to, for a lens author. */
export function lensReport(lenses: readonly Lens[], progress: ReviewProgress) {
  return {
    lenses: lenses.map((lens) => {
      const resolved = progress.lenses.find((item) => item.id === lens.id);

      return {
        ...lens,
        fileCount:
          resolved && resolved.state !== "unavailable" ? resolved.fileCount : 0,
        ...(resolved?.state === "unavailable" && {
          unavailable: resolved.reason,
        }),
      };
    }),
    uncategorized: uncategorizedReport(progress),
  };
}
