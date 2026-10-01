// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReviewDiffFileWire,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
  ReviewDiffViewSpec,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { createDiffView } from "./diff-view.tsx";
import type { PortalEntry, Portals } from "./portals.tsx";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    fileDiff,
  }: {
    fileDiff: {
      name: string;
      hunks: {
        deletionStart: number;
        deletionCount: number;
        additionStart: number;
        additionCount: number;
      }[];
    };
  }) => {
    const hunk = fileDiff.hunks[0];

    return (
      <pre data-testid="pierre">
        {`@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`}
      </pre>
    );
  },
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useCodeTheme: () => ({ mode: "dark", name: "bb-monokai", theme: null }),
}));

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
const text = (values: string[]) => `${values.join("\n")}\n`;
const appHead = lines(40);

appHead[19] = "changed 20";

const FILES: ReviewDiffFileWire[] = [
  { path: "src/app.ts", status: "modified", additions: 1, deletions: 1 },
  { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1 },
  { path: "README.md", status: "added", additions: 2, deletions: 0 },
];

const TEXTS: Record<string, string> = {
  "base:src/app.ts": text(lines(40)),
  "head:src/app.ts": text(appHead),
  "base:src/old.ts": "alpha\nbeta\n",
  "head:src/new.ts": "alpha\nBETA\n",
  "head:README.md": "one\ntwo\n",
};

function harness(options: { failFiles?: boolean } = {}) {
  const requests: string[] = [];
  const request = async (url: string) => {
    const parsed = new URL(url);

    requests.push(`${parsed.pathname}?${parsed.searchParams}`);

    if (parsed.pathname === "/reviews-api/r1/diff")
      return options.failFiles
        ? Response.json({ error: "boom" }, { status: 500 })
        : Response.json(FILES);
    const key = `${parsed.searchParams.get("side")}:${parsed.searchParams.get("file")}`;

    return Response.json({ text: TEXTS[key] });
  };
  const entries = new Map<string, PortalEntry>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision++;

    for (const listener of listeners) listener();
  };
  const portals: Portals = {
    mount(entry) {
      entries.set(entry.id, entry);
      notify();

      return () => {
        entries.delete(entry.id);
        notify();
      };
    },
    update(id, element) {
      const entry = entries.get(id);

      if (entry) entries.set(id, { ...entry, element });
      notify();
    },
  };
  function Host() {
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
      () => revision,
    );

    return (
      <>
        {[...entries.values()].map((entry) =>
          createPortal(entry.element, entry.container, entry.id),
        )}
      </>
    );
  }
  render(<Host />);
  const factory = createDiffView({
    request,
    reviewId: "r1",
    portals,
    events: { emit() {}, subscribe: () => ({ dispose() {} }) },
    sourceView: () => ({ reviewId: "r1", version: 3 }),
  });
  const container = document.createElement("div");
  const tree = document.createElement("div");

  document.body.append(container, tree);
  const spec = (overrides: Partial<ReviewDiffViewSpec> = {}): ReviewDiffViewSpec => ({
    container,
    fileTreeContainer: tree,
    ...overrides,
  });

  return { factory, entries, container, tree, spec, requests };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const headers = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".review-multidiff-header")].map((header) => [
    header.querySelector(".review-path-label")?.textContent,
    header.getAttribute("aria-expanded"),
  ]);
const hunks = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-testid=pierre]")].map((node) => node.textContent);
const gaps = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-wb-gap]")].map((gap) => gap.textContent);
const file = (path: string, state: ReviewDiffProgressFile["state"]): ReviewDiffProgressFile => ({
  path,
  state,
  remaining: state === "viewed" ? { additions: 0, deletions: 0 } : { additions: 1, deletions: 1 },
  total: { additions: 1, deletions: 1 },
  viewedRanges: [],
  changedRanges: [],
});
const lens: ReviewDiffLens = {
  id: "lens-1",
  title: "Lens",
  reviewId: "r1",
  version: 3,
  ranges: [
    { file: "src/app.ts", side: "head", fromLine: 19, toLine: 21 },
    { file: "src/old.ts", side: "base", fromLine: 2, toLine: 2 },
  ],
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("diff view", () => {
  it("lists the comparison's files at the canvas version or a commit", async () => {
    const { factory, requests } = harness();

    expect(await factory.files()).toEqual(FILES);
    expect(await factory.files({ commit: "abc" })).toEqual(FILES);
    expect(requests).toEqual([
      "/reviews-api/r1/diff?version=3&format=files",
      "/reviews-api/r1/diff?version=3&commit=abc&format=files",
    ]);
  });

  it("renders the tree beside the diffs, reveals a file from it, and toggles viewed from the header", async () => {
    const { factory, container, tree, spec } = harness();
    const toggled: [string, string | undefined][] = [];
    const handle = factory.create(
      spec({ onToggleViewed: (path, section) => toggled.push([path, section]) }),
    );

    await settle();
    // Folders first, then files, compressed: "src" holds app.ts and new.ts.
    expect(
      [...tree.querySelectorAll("[role=treeitem]")].map((item) => item.getAttribute("aria-label")),
    ).toEqual(["src", "src/app.ts", "src/new.ts", "README.md"]);
    expect(headers(container)).toEqual([
      ["src/app.ts", "true"],
      ["src/new.ts", "true"],
      ["README.md", "true"],
    ]);
    // Without a lens or progress, unchanged regions fold with 3 lines of context, as Monaco does.
    expect(hunks(container)).toEqual(["@@ -17,7 +17,7 @@", "@@ -1,2 +1,2 @@", "@@ -0,0 +1,2 @@"]);
    expect(gaps(container)).toEqual(["⋯Unchanged · 16 lines", "⋯Unchanged · 17 lines"]);

    await act(async () => (tree.querySelector('[aria-label="src/new.ts"]') as HTMLElement).click());
    expect(tree.querySelector('[aria-label="src/new.ts"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );

    await act(async () =>
      (container.querySelector('[aria-label="Mark viewed: src/app.ts"]') as HTMLElement).click(),
    );
    expect(toggled).toEqual([["src/app.ts", undefined]]);
    // The box does not toggle the file open or closed.
    expect(headers(container)[0]).toEqual(["src/app.ts", "true"]);

    act(() => handle.dispose());
    expect(container.childElementCount).toBe(0);
    expect(tree.childElementCount).toBe(0);
  });

  it("collapses a file once it is viewed and reopens it when unviewed", async () => {
    const { factory, container, tree, spec } = harness();
    const progress = (state: ReviewDiffProgressFile["state"]): ReviewDiffProgress => ({
      files: [file("src/app.ts", state), file("src/new.ts", "unread")],
    });
    const handle = factory.create(spec({ progress: progress("viewed") }));

    await settle();
    expect(headers(container).slice(0, 2)).toEqual([
      ["src/app.ts", "false"],
      ["src/new.ts", "true"],
    ]);
    expect(
      container
        .querySelector('[aria-label="Mark unviewed: src/app.ts"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(tree.querySelector('[aria-label="src/app.ts"]')?.className).toContain(
      "review-file-viewed",
    );

    act(() => handle.setProgress?.(progress("unread")));
    await settle();
    expect(headers(container)[0]).toEqual(["src/app.ts", "true"]);
    act(() => handle.dispose());
  });

  it("shows only a lens's files, folds outside its ranges, and expands a gap on click", async () => {
    const { factory, container, spec } = harness();
    const handle = factory.create(spec({ lens }));

    await settle();
    expect(headers(container).map(([path]) => path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(hunks(container)).toEqual(["@@ -16,9 +16,9 @@", "@@ -1,2 +1,2 @@"]);
    expect(gaps(container)).toEqual(["⋯Outside lens · 15 lines", "⋯Outside lens · 16 lines"]);

    await act(async () => (container.querySelector("[data-wb-gap]") as HTMLElement).click());
    expect(hunks(container)[0]).toBe("@@ -1,24 +1,24 @@");
    act(() => handle.dispose());
  });

  it("reveals a source behind a gap", async () => {
    const { factory, container, spec } = harness();
    const handle = factory.create(spec({ lens }));

    act(() =>
      handle.revealSource?.({ file: "src/app.ts", side: "head", fromLine: 30, toLine: 30 }),
    );
    await settle();
    expect(gaps(container)).toEqual(["⋯Outside lens · 15 lines"]);
    expect(hunks(container)[0]).toBe("@@ -16,25 +16,25 @@");
    act(() => handle.dispose());
  });

  it("groups a lens by its sections and toggles a section", async () => {
    const { factory, container, spec } = harness();
    const sectionToggles: string[] = [];
    const section = (id: string, label: string, sources: ReviewDiffLens["ranges"]) => ({
      id,
      label,
      sources,
      state: "unread" as const,
      total: { additions: 1, deletions: 1 },
      remaining: { additions: 1, deletions: 1 },
    });
    const handle = factory.create(
      spec({
        lens,
        onToggleSection: (id) => sectionToggles.push(id),
        progress: {
          files: [],
          sections: [
            section("s1", "The change", [lens.ranges[0]]),
            section("s2", "The rename", [lens.ranges[1]]),
          ],
        },
      }),
    );

    await settle();
    expect(
      [...container.querySelectorAll(".review-diff-group-title, .review-path-label")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["The change", "src/app.ts", "The rename", "src/new.ts"]);

    await act(async () =>
      (container.querySelector('[aria-label="Mark viewed: The rename"]') as HTMLElement).click(),
    );
    expect(sectionToggles).toEqual(["s2"]);

    await act(async () =>
      (
        container.querySelector('[aria-label="Collapse section: The change"]') as HTMLElement
      ).click(),
    );
    expect(
      [...container.querySelectorAll(".review-path-label")].map((node) => node.textContent),
    ).toEqual(["src/new.ts"]);
    act(() => handle.dispose());
  });

  it("reports a failed files request and a lens on another comparison through onDidError", async () => {
    const { factory, spec } = harness({ failFiles: true });
    const errors: string[] = [];
    const failed = factory.create(spec());

    failed.onDidError((message) => errors.push(message));
    factory
      .create(spec({ lens, scope: { commit: "abc" } }))
      .onDidError((message) => errors.push(message));
    await settle();
    expect(errors.sort()).toEqual(["A lens must use its review comparison.", "boom"]);
    act(() => failed.dispose());
  });
});
