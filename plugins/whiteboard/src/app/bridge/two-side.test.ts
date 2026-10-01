import { getSingularPatch, parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  alignRows,
  foldGaps,
  lensFiles,
  orderDiffFiles,
  resolveSide,
  segmentPatch,
  segments,
  sideText,
  viewedRows,
} from "./two-side.ts";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const text = (values: string[]) => `${values.join("\n")}\n`;
const rowsOf = (base: string, head: string) =>
  alignRows(parseDiffFromFile({ name: "a.ts", contents: base }, { name: "a.ts", contents: head }));

describe("resolveSide", () => {
  it("reads a renamed file's base at its previous path and its head at the new one", () => {
    const file = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" };

    expect(resolveSide({ ...file, side: "base" })).toEqual({ path: "src/old.ts", side: "base" });
    expect(resolveSide({ ...file, side: "head" })).toEqual({ path: "src/new.ts", side: "head" });
  });

  it("has no base for an added file and no head for a deleted one", () => {
    expect(resolveSide({ path: "a.ts", status: "added", side: "base" })).toBeNull();
    expect(resolveSide({ path: "a.ts", status: "added", side: "head" })).toEqual({
      path: "a.ts",
      side: "head",
    });
    expect(resolveSide({ path: "a.ts", status: "deleted", side: "head" })).toBeNull();
    expect(resolveSide({ path: "a.ts", status: "deleted", side: "base" })).toEqual({
      path: "a.ts",
      side: "base",
    });
  });

  it("reads both sides of a modified file at its path", () => {
    expect(resolveSide({ path: "a.ts", status: "modified", side: "base" })).toEqual({
      path: "a.ts",
      side: "base",
    });
  });
});

describe("lensFiles and orderDiffFiles", () => {
  const files = [
    { path: "z.ts", status: "modified" as const, additions: 1, deletions: 0 },
    {
      path: "src/b.ts",
      previousPath: "src/a.ts",
      status: "renamed" as const,
      additions: 0,
      deletions: 0,
    },
    { path: "src/lib/c.ts", status: "added" as const, additions: 2, deletions: 0 },
  ];

  it("adds referenced files outside the comparison as unchanged context, once", () => {
    const lens = {
      id: "l",
      title: "L",
      reviewId: "r",
      version: 1,
      ranges: [
        { file: "src/a.ts", side: "base" as const, fromLine: 1, toLine: 2 },
        { file: "docs/x.md", side: "head" as const, fromLine: 1, toLine: 1 },
        { file: "docs/x.md", side: "head" as const, fromLine: 4, toLine: 5 },
      ],
    };

    expect(lensFiles(files, lens).map((file) => [file.path, file.status])).toEqual([
      ["z.ts", "modified"],
      ["src/b.ts", "renamed"],
      ["src/lib/c.ts", "added"],
      ["docs/x.md", "unchanged"],
    ]);
    expect(lensFiles(files, { ...lens, wholeFiles: true })).toBe(files);
  });

  it("orders folders first, then files by name, like the tree", () => {
    expect(orderDiffFiles(files).map((file) => file.path)).toEqual([
      "src/lib/c.ts",
      "src/b.ts",
      "z.ts",
    ]);
  });
});

describe("alignRows", () => {
  it("pairs unchanged lines, zips a change block, and leaves a trailing insertion one-sided", () => {
    const rows = rowsOf("a\nb\nc\nd\n", "a\nB\nX\nd\ne\n");

    expect(rows).toEqual([
      { base: 0, head: 0, changed: false },
      { base: 1, head: 1, changed: true },
      { base: 2, head: 2, changed: true },
      { base: 3, head: 3, changed: false },
      { base: null, head: 4, changed: true },
    ]);
  });

  it("aligns an added file as head-only rows", () => {
    expect(rowsOf("", "q\nr\n")).toEqual([
      { base: null, head: 0, changed: true },
      { base: null, head: 1, changed: true },
    ]);
  });
});

describe("foldGaps", () => {
  const base = lines(40);
  const head = [...base];

  head[19] = "changed 20";
  const rows = rowsOf(text(base), text(head));

  it("folds everything but the lens ranges and 3 rows of context as Outside lens", () => {
    const gaps = foldGaps(rows, {
      lens: [{ file: "a.ts", side: "head", fromLine: 10, toLine: 12 }],
    });

    expect(gaps).toEqual([
      { start: 0, end: 6, label: "Outside lens", collapsed: true },
      { start: 15, end: 40, label: "Outside lens", collapsed: true },
    ]);
  });

  it("folds viewed rows, keeps unread changes open, and lets unfold ranges reopen a gap", () => {
    const progress = {
      viewedRanges: [{ file: "a.ts", side: "head" as const, fromLine: 1, toLine: 40 }],
      changedRanges: [{ file: "a.ts", side: "head" as const, fromLine: 20, toLine: 20 }],
    };
    const viewed = foldGaps(rows, { progress });

    expect(viewed.map(({ start, end, label }) => [start, end, label])).toEqual([[0, 40, "Viewed"]]);
    // Unread: the changed row stays visible, the unchanged rest folds.
    expect(
      foldGaps(rows, { progress: { ...progress, viewedRanges: [] } }).map(
        ({ start, end, label }) => [start, end, label],
      ),
    ).toEqual([
      [0, 16, "Unchanged"],
      [23, 40, "Unchanged"],
    ]);
    expect(
      foldGaps(rows, {
        progress: {
          ...progress,
          unfoldRanges: [{ file: "a.ts", side: "head", fromLine: 5, toLine: 5 }],
        },
      })[0].collapsed,
    ).toBe(false);
  });

  it("without progress or lens hides unchanged regions with 3 rows of context, as Monaco does", () => {
    expect(foldGaps(rows, {}).map(({ start, end }) => [start, end])).toEqual([
      [0, 16],
      [23, 40],
    ]);
  });

  it("splits rows into visible runs and gap bars, honoring expanded gaps", () => {
    const gaps = foldGaps(rows, {
      lens: [{ file: "a.ts", side: "head", fromLine: 10, toLine: 12 }],
    });

    expect(segments(rows.length, gaps)).toEqual([
      { kind: "gap", start: 0, end: 6, label: "Outside lens" },
      { kind: "rows", start: 6, end: 15 },
      { kind: "gap", start: 15, end: 40, label: "Outside lens" },
    ]);
    expect(segments(rows.length, gaps, new Set([0]))).toEqual([
      { kind: "rows", start: 0, end: 15 },
      { kind: "gap", start: 15, end: 40, label: "Outside lens" },
    ]);
  });
});

describe("segmentPatch", () => {
  it("emits one hunk with true line numbers that pierre parses", () => {
    const base = lines(30);
    const head = [...base];

    head.splice(14, 1, "changed 15", "inserted");
    const baseText = sideText(text(base));
    const headText = sideText(text(head));
    const rows = rowsOf(text(base), text(head));
    const patch = segmentPatch({
      path: "src/a.ts",
      rows,
      base: baseText,
      head: headText,
      start: 11,
      end: 19,
    });

    expect(patch).toBe(
      [
        "--- src/a.ts",
        "+++ src/a.ts",
        "@@ -12,7 +12,8 @@",
        " line 12",
        " line 13",
        " line 14",
        "-line 15",
        "+changed 15",
        "+inserted",
        " line 16",
        " line 17",
        " line 18",
        "",
      ].join("\n"),
    );
    const parsed = getSingularPatch(patch);

    expect(parsed.name).toBe("src/a.ts");
    expect(parsed.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart])).toEqual([
      [12, 12],
    ]);
  });

  it("marks a missing final newline and numbers a head-only run from the line before", () => {
    const rows = rowsOf("a\nb", "a\nc");
    const patch = segmentPatch({
      path: "x",
      rows,
      base: sideText("a\nb"),
      head: sideText("a\nc"),
      start: 1,
      end: 2,
    });

    expect(patch).toBe(
      "--- x\n+++ x\n@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
    );
    const added = rowsOf("", "q\nr\n");

    expect(
      segmentPatch({
        path: "x",
        rows: added,
        base: sideText(""),
        head: sideText("q\nr\n"),
        start: 0,
        end: 2,
      }),
    ).toBe("--- x\n+++ x\n@@ -0,0 +1,2 @@\n+q\n+r\n");
  });
});

/** Desktop `reviewLens.test.ts` (no structural provider), over alignment rows. */
describe("lens and viewed folds (upstream reviewLens cases)", () => {
  const spans = (gaps: { start: number; end: number }[]) =>
    gaps.map(({ start, end }) => [start, end]);

  it("a lens keeps disjoint attachments and hides the intervening code", () => {
    const rows = rowsOf(text(lines(100)), text(lines(100)));

    // Upstream: originalStart/count [1, 16], [26, 41], [76, 25].
    expect(
      spans(
        foldGaps(rows, {
          lens: [
            { side: "head", file: "a.ts", fromLine: 20, toLine: 22 },
            { side: "base", file: "a.ts", fromLine: 70, toLine: 72 },
          ],
        }),
      ),
    ).toEqual([
      [0, 16],
      [25, 66],
      [75, 100],
    ]);
  });

  it("one-sided inserted ranges use correspondence without hiding their opposite context", () => {
    const rows = rowsOf("", text(lines(50)));

    // Upstream: modifiedStart/count [1, 16], [29, 22].
    expect(
      spans(foldGaps(rows, { lens: [{ side: "head", file: "new.ts", fromLine: 20, toLine: 25 }] })),
    ).toEqual([
      [0, 16],
      [28, 50],
    ]);
  });

  it("viewed folds never hide an unread counterpart", () => {
    const rows = rowsOf(text(lines(10)), text(lines(10)));
    const range = (side: "base" | "head", fromLine: number, toLine: number) => ({
      side,
      file: "a.ts",
      fromLine,
      toLine,
    });
    const changed = [range("base", 3, 5), range("head", 3, 5)];

    expect(viewedRows(rows, [range("head", 3, 5)], changed).some(Boolean)).toBe(false);
    expect(
      viewedRows(rows, changed, changed).flatMap((hidden, index) => (hidden ? [index] : [])),
    ).toEqual([2, 3, 4]);
  });
});
