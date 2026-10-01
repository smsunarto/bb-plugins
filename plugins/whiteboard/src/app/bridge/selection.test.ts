// @vitest-environment jsdom
import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import type { ReviewSurfaceEvent } from "../../shared/vendor/review-protocol/src/index.ts";
import { selectedDiff, selectionRange, trackSelection } from "./selection.ts";
import { alignRows } from "./two-side.ts";

const base = ["a", "b", "c", "d", "e"];
const head = ["a", "B", "c", "inserted", "d", "e"];
const surface = {
  basePath: "src/old.ts",
  headPath: "src/new.ts",
  rows: alignRows(
    parseDiffFromFile(
      { name: "src/old.ts", contents: `${base.join("\n")}\n` },
      { name: "src/new.ts", contents: `${head.join("\n")}\n` },
    ),
  ),
  base,
  head,
};

function harness(source?: { version?: number; pins?: { repositoryId: string; head: string } }) {
  const emitted: ReviewSurfaceEvent[] = [];
  const root = document.createElement("div");
  const tracker = trackSelection({
    root,
    reviewId: "review-1",
    events: {
      emit: (event) => emitted.push(event),
      subscribe: () => ({ dispose() {} }),
    },
    source: () => ({ reviewId: "review-1", ...source }),
  });

  return { emitted, root, tracker };
}

describe("selection", () => {
  it("emits editorSelectionChanged for a base-side selection at the base file, with its range and diff", () => {
    const { emitted, root, tracker } = harness({ version: 4 });

    root.dispatchEvent(new MouseEvent("mouseup", { clientX: 120, clientY: 48, bubbles: true }));
    tracker.select(surface, { start: 2, end: 3, side: "deletions" });

    expect(emitted).toEqual([
      {
        event: "editorSelectionChanged",
        reviewId: "review-1",
        anchor: { x: 120, y: 48 },
        path: "src/old.ts",
        sideContext: "base",
        isEmpty: false,
        range: { fromLine: 2, toLine: 3 },
        selectedDiff: {
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          oldStart: 2,
          newStart: 2,
          rows: [
            { kind: "deleted", text: "b" },
            { kind: "added", text: "B" },
            { kind: "unchanged", text: "c" },
          ],
        },
        apiSource: { reviewId: "review-1", version: 4 },
      },
    ]);
  });

  it("emits a head selection at the head file; an insertion it crosses joins the excerpt", () => {
    const { emitted, tracker } = harness({
      version: 4,
      pins: { repositoryId: "repo", head: "abc" },
    });

    tracker.select(surface, { start: 5, end: 3, side: "additions" });
    const event = emitted[0] as Extract<ReviewSurfaceEvent, { event: "editorSelectionChanged" }>;

    expect([event.path, event.sideContext, event.range]).toEqual([
      "src/new.ts",
      "head",
      { fromLine: 3, toLine: 5 },
    ]);
    expect(event.apiSource).toEqual({
      reviewId: "review-1",
      version: 4,
      pins: { repositoryId: "repo", head: "abc" },
    });
    expect(event.selectedDiff?.rows).toEqual([
      { kind: "unchanged", text: "c" },
      { kind: "added", text: "inserted" },
      { kind: "unchanged", text: "d" },
    ]);
  });

  it("clears with an empty event and stops after dispose", () => {
    const { emitted, tracker } = harness();

    tracker.select(surface, { start: 1, end: 1, side: "additions" });
    tracker.select(surface, null);
    tracker.dispose();
    tracker.select(surface, { start: 1, end: 1, side: "additions" });

    expect(
      emitted.map(
        (event) => event.event === "editorSelectionChanged" && [event.isEmpty, event.path],
      ),
    ).toEqual([
      [false, "src/new.ts"],
      [true, "src/new.ts"],
    ]);
    // Without a known version the selection names no apiSource.
    expect("apiSource" in emitted[0]).toBe(false);
  });

  it("keeps a cross-side range on its start side", () => {
    expect(
      selectionRange(surface, { start: 2, side: "deletions", end: 4, endSide: "additions" }),
    ).toEqual({
      side: "base",
      fromLine: 2,
      toLine: 3,
    });
  });

  it("expands a one-sided insertion only when the selection crosses it", () => {
    // Base lines 3-4 straddle the insertion between "c" and "d".
    expect(selectedDiff(surface, "base", 3, 4)?.rows).toEqual([
      { kind: "unchanged", text: "c" },
      { kind: "added", text: "inserted" },
      { kind: "unchanged", text: "d" },
    ]);
    expect(selectedDiff(surface, "base", 5, 5)?.rows).toEqual([{ kind: "unchanged", text: "e" }]);
  });
});

/** Desktop `reviewDiffSelection.test.ts`, over pierre's alignment instead of Monaco line changes. */
describe("selectedDiff (upstream reviewDiffSelection cases)", () => {
  const surfaceOf = (
    basePath: string | null,
    headPath: string | null,
    baseLines: string[],
    headLines: string[],
  ) => ({
    basePath,
    headPath,
    base: baseLines,
    head: headLines,
    rows: alignRows(
      parseDiffFromFile(
        { name: basePath ?? "x", contents: baseLines.length ? `${baseLines.join("\n")}\n` : "" },
        { name: headPath ?? "x", contents: headLines.length ? `${headLines.join("\n")}\n` : "" },
      ),
    ),
  });
  const replaced = surfaceOf(
    "old.ts",
    "new.ts",
    ["before", "old", "after"],
    ["before", "new", "extra", "after"],
  );

  it("copy from either pane retains both sides of a replacement and rename paths", () => {
    for (const side of ["base", "head"] as const)
      expect(selectedDiff(replaced, side, 2, 2)).toEqual({
        oldPath: "old.ts",
        newPath: "new.ts",
        oldStart: 2,
        newStart: 2,
        rows: [
          { kind: "deleted", text: "old" },
          { kind: "added", text: "new" },
          { kind: "added", text: "extra" },
        ],
      });
  });

  it("context after a replacement retains correct base/head offsets", () => {
    const diff = selectedDiff(replaced, "head", 4, 4);

    expect([diff?.oldStart, diff?.newStart, diff?.rows]).toEqual([
      3,
      4,
      [{ kind: "unchanged", text: "after" }],
    ]);
  });

  it("added and deleted files use zero-count opposite sides", () => {
    const added = selectedDiff(surfaceOf(null, "new.ts", [], ["a", "b"]), "head", 1, 2);

    expect([added?.oldPath, added?.oldStart, added?.rows.map((row) => row.kind)]).toEqual([
      "",
      0,
      ["added", "added"],
    ]);
    const removed = selectedDiff(surfaceOf("old.ts", null, ["a", "b"], []), "base", 1, 2);

    expect([removed?.newPath, removed?.newStart, removed?.rows.map((row) => row.kind)]).toEqual([
      "",
      0,
      ["deleted", "deleted"],
    ]);
  });

  it("selection crossing a deletion includes it, adjacent context alone does not", () => {
    const deletion = surfaceOf("a", "a", ["a", "removed", "b"], ["a", "b"]);

    expect(selectedDiff(deletion, "head", 1, 2)?.rows.map((row) => row.kind)).toEqual([
      "unchanged",
      "deleted",
      "unchanged",
    ]);
    expect(selectedDiff(deletion, "head", 2, 2)?.rows).toEqual([{ kind: "unchanged", text: "b" }]);
  });

  it("partial selection of a newly added file copies only selected lines", () => {
    const diff = selectedDiff(surfaceOf(null, "new.ts", [], ["a", "b", "c"]), "head", 2, 2);

    expect([diff?.newStart, diff?.rows]).toEqual([2, [{ kind: "added", text: "b" }]]);
  });
});
