// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    row.textContent,
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
    // Without a Viewed toggle, rows carry no checked state.
    expect(container.querySelector("[aria-checked]")).toBeNull();
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
      container.querySelector<HTMLElement>('[aria-label="packages/core/src"]')!.click(),
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

  describe("keyboard", () => {
    const flat: ReviewDiffFileWire[] = [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "src/b.ts", status: "added", additions: 2, deletions: 0 },
      { path: "README.md", status: "modified", additions: 1, deletions: 0 },
    ];
    const item = (name: string) => screen.getByRole("treeitem", { name });
    const setup = () => {
      const onToggleViewed = vi.fn();
      const { container } = render(
        <DiffFileTree
          files={flat}
          showFileCounts
          onReveal={() => {}}
          onToggleViewed={onToggleViewed}
        />,
      );
      return { container, onToggleViewed };
    };

    it("has exactly one tab stop", () => {
      const { container } = setup();

      expect(
        [...container.querySelectorAll("[role=treeitem][tabindex='0']")].map((row) =>
          row.getAttribute("aria-label"),
        ),
      ).toEqual(["src"]);
    });

    it("moves down into a folder and jumps to the last row", () => {
      setup();
      act(() => item("src").focus());

      fireEvent.keyDown(item("src"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(item("src/a.ts"));

      fireEvent.keyDown(item("src/a.ts"), { key: "End" });
      expect(document.activeElement).toBe(item("README.md"));
      expect(item("README.md").tabIndex).toBe(0);
      expect(item("src").tabIndex).toBe(-1);
    });

    it("collapses an expanded folder with ArrowLeft", () => {
      setup();

      fireEvent.keyDown(item("src"), { key: "ArrowLeft" });
      expect(item("src").getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("treeitem", { name: "src/a.ts" })).toBeNull();
    });

    it("moves from a file to its folder with ArrowLeft and reopens it with ArrowRight", () => {
      setup();

      fireEvent.keyDown(item("src/b.ts"), { key: "ArrowLeft" });
      expect(document.activeElement).toBe(item("src"));

      fireEvent.keyDown(item("src"), { key: "ArrowLeft" });
      fireEvent.keyDown(item("src"), { key: "ArrowRight" });
      expect(item("src").getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(item("src"), { key: "ArrowRight" });
      expect(document.activeElement).toBe(item("src/a.ts"));
    });

    it("toggles Viewed with Space on a file", () => {
      const { onToggleViewed } = setup();

      fireEvent.keyDown(item("src/a.ts"), { key: " " });
      // Holding Space does not flip it back and forth.
      fireEvent.keyDown(item("src/a.ts"), { key: " ", repeat: true });
      expect(onToggleViewed.mock.calls).toEqual([["src/a.ts"]]);
    });

    it("exposes each file's Viewed state on its row", () => {
      const progressFile = (path: string, state: "viewed" | "partial") => ({
        path,
        state,
        remaining: { additions: 0, deletions: 0 },
        total: { additions: 1, deletions: 1 },
        viewedRanges: [],
        changedRanges: [],
      });
      render(
        <DiffFileTree
          files={flat}
          progress={{
            files: [progressFile("src/a.ts", "viewed"), progressFile("src/b.ts", "partial")],
          }}
          onReveal={() => {}}
          onToggleViewed={() => {}}
        />,
      );

      expect(
        ["src", "src/a.ts", "src/b.ts", "README.md"].map((name) =>
          item(name).getAttribute("aria-checked"),
        ),
      ).toEqual([null, "true", "mixed", "false"]);
    });

    it("renders the Viewed box as the lens rows' button, out of tab order and hidden", () => {
      const { container, onToggleViewed } = setup();
      const box = container.querySelector<HTMLElement>(
        '[data-review-file="src/a.ts"] + .review-viewed-check',
      )!;

      expect(container.querySelector("input[type=checkbox]")).toBeNull();
      expect([box.tagName, box.getAttribute("tabindex"), box.getAttribute("aria-hidden")]).toEqual([
        "BUTTON",
        "-1",
        "true",
      ]);
      fireEvent.click(box);
      expect(onToggleViewed.mock.calls).toEqual([["src/a.ts"]]);
    });
  });
});
