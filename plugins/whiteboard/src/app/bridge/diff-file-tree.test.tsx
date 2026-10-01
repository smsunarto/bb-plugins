// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ReviewDiffFileWire,
  ReviewDiffProgress,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { DiffFileTree } from "./diff-file-tree.tsx";

const files: ReviewDiffFileWire[] = [
  { path: "packages/core/src/a.ts", status: "modified", additions: 3, deletions: 1 },
  { path: "packages/core/src/b.ts", status: "added", additions: 1200, deletions: 0 },
  { path: "docs/notes.md", status: "unchanged", additions: 0, deletions: 0 },
  { path: "z.ts", status: "deleted", additions: 0, deletions: 4 },
];

const rows = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[role=treeitem]")].map((row) => [
    row.getAttribute("aria-label"),
    (row.matches("button") ? row : row.querySelector(":scope > button"))?.textContent,
  ]);

afterEach(cleanup);

describe("DiffFileTree", () => {
  it("compresses single-child folders and shows each file's diff counts", () => {
    const { container } = render(<DiffFileTree files={files} showFileCounts onReveal={() => {}} />);

    expect(rows(container)).toEqual([
      ["docs", "docs"],
      ["docs/notes.md", "notes.mdUnchanged"],
      ["packages/core/src", "packages/core/src"],
      ["packages/core/src/a.ts", "a.ts+3 −1"],
      ["packages/core/src/b.ts", "b.ts+1.2k −0"],
      ["z.ts", "z.ts+0 −4"],
    ]);
  });

  it("shows remaining counts and Viewed from progress, with the remaining-of-total tooltip", () => {
    const progress: ReviewDiffProgress = {
      files: [
        {
          path: "packages/core/src/a.ts",
          state: "partial",
          remaining: { additions: 1, deletions: 0 },
          total: { additions: 3, deletions: 1 },
          viewedRanges: [],
          changedRanges: [],
        },
        {
          path: "z.ts",
          state: "viewed",
          remaining: { additions: 0, deletions: 0 },
          total: { additions: 0, deletions: 4 },
          viewedRanges: [],
          changedRanges: [],
        },
      ],
    };
    const { container } = render(
      <DiffFileTree files={files} progress={progress} onReveal={() => {}} />,
    );
    const row = (path: string) => container.querySelector<HTMLElement>(`[aria-label="${path}"]`)!;

    expect(row("packages/core/src/a.ts").textContent).toBe("a.ts+1 −0");
    expect(row("packages/core/src/a.ts").title).toBe("+1 −0 remaining\nof +3 −1 total");
    expect(row("z.ts").textContent).toBe("z.tsViewed");
    // Without progress for it, and with counts off, a file waits for coverage.
    expect(row("packages/core/src/b.ts").title).toBe("Waiting for structural coverage");
  });

  it("reveals a file on click and collapses a folder", async () => {
    const revealed: string[] = [];
    const { container } = render(
      <DiffFileTree
        files={files}
        activePath="z.ts"
        showFileCounts
        onReveal={(path) => revealed.push(path)}
      />,
    );

    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="packages/core/src/a.ts"]')!.click(),
    );
    expect(revealed).toEqual(["packages/core/src/a.ts"]);
    expect(container.querySelector('[aria-label="z.ts"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );

    await act(async () =>
      container.querySelector<HTMLElement>('[aria-label="packages/core/src"] > button')!.click(),
    );
    expect(rows(container).map(([path]) => path)).toEqual([
      "docs",
      "docs/notes.md",
      "packages/core/src",
      "z.ts",
    ]);
  });

  // Desktop `reviewChangedFilesTree.test.ts`.
  it("a folded file reads as done: greyed like a viewed one, Folded in place of its counts", () => {
    const { container } = render(
      <DiffFileTree
        files={[files[0]]}
        progress={{
          files: [
            {
              path: files[0].path,
              state: "folded",
              remaining: { additions: 0, deletions: 0 },
              total: { additions: 3, deletions: 1 },
              viewedRanges: [],
              changedRanges: [],
            },
          ],
        }}
        onReveal={() => {}}
      />,
    );
    const row = container.querySelector<HTMLElement>(`[aria-label="${files[0].path}"]`)!;

    expect([row.textContent, row.title]).toEqual([
      "a.tsFolded",
      "Folded by default; counted as done\n+3 −1 total",
    ]);
    expect(row.classList.contains("review-file-folded")).toBe(true);
    expect(row.classList.contains("review-file-viewed")).toBe(false);
  });
});
