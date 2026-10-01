// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReviewDiffFileWire,
  ReviewDiffProgress,
  ReviewInlineEditorSpec,
  ReviewSurfaceEvent,
} from "../../shared/vendor/review-protocol/src/index.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";
import { createInlineEditors } from "./inline-editors.tsx";
import { createPortals, PortalHost, type PortalEntry, type Portals } from "./portals.tsx";

/** pierre's React `FileDiff` renders into a shadow root; this stand-in prints its hunk and keeps its options. */
const pierre = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    fileDiff,
    options,
  }: {
    fileDiff: {
      name: string;
      hunks: {
        deletionStart: number;
        deletionCount: number;
        additionStart: number;
        additionCount: number;
      }[];
      additionLines: string[];
    };
    options: Record<string, unknown>;
  }) => {
    pierre.options.push(options);
    const hunk = fileDiff.hunks[0];

    return (
      <pre data-testid="pierre" data-css={String(options.unsafeCSS ?? "")}>
        {`@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@ ${fileDiff.name}`}
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
  { path: "src/added.ts", status: "added", additions: 2, deletions: 0 },
  { path: "src/gone.ts", status: "deleted", additions: 0, deletions: 2 },
];

const TEXTS: Record<string, string> = {
  "base:src/app.ts": text(lines(40)),
  "head:src/app.ts": text(appHead),
  "base:src/old.ts": "alpha\nbeta\n",
  "head:src/new.ts": "alpha\nBETA\n",
  "head:src/added.ts": "one\ntwo\n",
  "base:src/gone.ts": "x\ny\n",
};

function harness(options: { hold?: Promise<void> } = {}) {
  const requests: string[] = [];
  const request = async (url: string) => {
    const parsed = new URL(url);

    requests.push(`${parsed.pathname}?${parsed.searchParams}`);

    if (options.hold && parsed.pathname.endsWith("/file")) await options.hold;

    if (parsed.pathname === "/reviews-api/r1/diff") return Response.json(FILES);
    const key = `${parsed.searchParams.get("side")}:${parsed.searchParams.get("file")}`;

    return key in TEXTS
      ? Response.json({ text: TEXTS[key] })
      : Response.json({ error: `missing ${key}` }, { status: 404 });
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
        if (entries.get(entry.id) !== entry) return;
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
  const emitted: ReviewSurfaceEvent[] = [];
  const factory = createInlineEditors({
    request,
    rpc: {} as WhiteboardRpcClient,
    reviewId: "r1",
    portals,
    events: { emit: (event) => emitted.push(event), subscribe: () => ({ dispose() {} }) },
    sourceView: () => ({ reviewId: "r1", version: 3 }),
  });
  const container = document.createElement("div");

  document.body.append(container);
  const spec = (overrides: Partial<ReviewInlineEditorSpec> = {}): ReviewInlineEditorSpec => ({
    container,
    path: "src/app.ts",
    title: "src/app.ts:19-21",
    side: "head",
    ranges: [{ startLine: 19, endLine: 21 }],
    heightMode: "content",
    active: false,
    ...overrides,
  });

  return { factory, entries, container, spec, requests, emitted };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const query = (text: string) => ({ text, matchCase: false, wholeWord: false, isRegex: false });
const css = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-testid=pierre]")].map(
    (node) => node.dataset.css,
  );

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  pierre.options.length = 0;
});

describe("inline editors", () => {
  it("mounts a lensed peek with true line numbers, reports its height, and dispose removes the portal", async () => {
    const { factory, entries, container, spec } = harness();
    const heights: number[] = [];
    const handle = factory.create(spec());

    // Desktop's estimate until the sides are read: (3 lines + 3 before + 3 after) × 20 + 36.
    expect(handle.height).toBe(216);
    handle.onDidChangeHeight((height) => heights.push(height));
    await settle();

    expect(entries.size).toBe(1);
    expect(container.querySelector(".review-path-label")?.textContent).toBe("src/app.ts");
    // Rows 16-24 stay (lines 19-21 ± 3); lines 1-15 and 25-40 fold Outside lens.
    expect(container.querySelector("[data-testid=pierre]")?.textContent).toBe(
      "@@ -16,9 +16,9 @@ src/app.ts",
    );
    expect([...container.querySelectorAll("[data-wb-gap]")].map((gap) => gap.textContent)).toEqual([
      "⋯Outside lens · 15 lines",
      "⋯Outside lens · 16 lines",
    ]);
    // Header 36 + gap 26 + 9 rows × 20 + gap 26.
    expect(heights).toEqual([268]);
    expect(handle.height).toBe(268);

    await act(async () => (container.querySelector("[data-wb-gap]") as HTMLElement).click());
    expect(heights.at(-1)).toBe(36 + 24 * 20 + 26);

    act(() => handle.dispose());
    expect(entries.size).toBe(0);
    expect(container.childElementCount).toBe(0);
  });

  it("mounts through the real portal registry and dispose unmounts it", async () => {
    const portals = createPortals();

    render(<PortalHost portals={portals} />);
    const factory = createInlineEditors({
      request: async (url) => {
        const parsed = new URL(url);

        if (parsed.pathname.endsWith("/diff")) return Response.json(FILES);

        return Response.json({ text: TEXTS[`${parsed.searchParams.get("side")}:src/app.ts`] });
      },
      rpc: {} as WhiteboardRpcClient,
      reviewId: "r1",
      portals,
      events: { emit() {}, subscribe: () => ({ dispose() {} }) },
      sourceView: () => ({ reviewId: "r1", version: 3 }),
    });
    const container = document.createElement("div");

    document.body.append(container);
    const handle = factory.create({
      container,
      path: "src/app.ts",
      title: "src/app.ts:19-21",
      side: "head",
      ranges: [{ startLine: 19, endLine: 21 }],
      heightMode: "content",
      active: false,
    });

    await settle();
    expect(container.querySelector("[data-testid=pierre]")?.textContent).toBe(
      "@@ -16,9 +16,9 @@ src/app.ts",
    );
    act(() => handle.dispose());
    expect(container.childElementCount).toBe(0);
  });

  it("caps a capped peek at 400px and collapses to its header", async () => {
    const { factory, spec } = harness();
    const heights: number[] = [];
    const handle = factory.create(
      spec({ heightMode: "capped", ranges: [{ startLine: 1, endLine: 40 }] }),
    );

    handle.onDidChangeHeight((height) => heights.push(height));
    await settle();
    expect(handle.height).toBe(400);

    act(() => handle.setCollapsed(true));
    expect(heights.at(-1)).toBe(40);
    act(() => handle.dispose());
  });

  it("factory find counts what setFindQuery counts: the lens rows only, unchanged lines once", async () => {
    const { factory, spec } = harness();
    const findSpec = {
      path: "src/app.ts",
      side: "head" as const,
      ranges: [{ startLine: 19, endLine: 21 }],
    };

    // Base "line 20" (changed), head "line 21".."line 24"; "line 2" and 25-29 are outside the lens.
    expect(await factory.find(findSpec, query("line 2"))).toEqual({ matchCount: 5 });
    expect(await factory.find(findSpec, query(""))).toEqual({ matchCount: 0 });
    const handle = factory.create(spec());

    expect(await act(() => handle.setFindQuery(query("line 2")))).toEqual({ matchCount: 5 });
    act(() => handle.dispose());
  });

  it("paints matches, the active one, and clearActiveFindMatch keeps the rest", async () => {
    const { factory, container, spec } = harness();
    const handle = factory.create(spec());

    await settle();
    await act(() => handle.setFindQuery(query("line 22")));
    expect(css(container)[0]).toBe(
      '[data-line="22"]:is([data-line-type="change-addition"],[data-line-type="context"],[data-line-type="context-expanded"]){background-color:var(--review-find-match-background) !important}',
    );

    act(() => handle.revealFindMatch(0));
    expect(css(container)[0]).toBe(
      '[data-line="22"]:is([data-line-type="change-addition"],[data-line-type="context"],[data-line-type="context-expanded"]){background-color:var(--review-find-match-active-background) !important}',
    );

    act(() => handle.clearActiveFindMatch());
    expect(css(container)[0]).toContain("--review-find-match-background");
    expect(css(container)[0]).not.toContain("active");

    act(() => handle.clearFind());
    expect(css(container)[0]).toBe("");
    act(() => handle.dispose());
  });

  it("reveals a match folded behind a gap", async () => {
    const { factory, container, spec } = harness();
    const handle = factory.create(spec({ ranges: [{ startLine: 20, endLine: 20 }] }));

    await settle();
    // "line 2" on head is outside the lens; reading at the whole file finds it through the base side too.
    await act(() => handle.setFindQuery(query("line 23")));
    act(() => handle.revealFindMatch(0));
    expect(container.querySelector("[data-testid=pierre]")?.textContent).toBe(
      "@@ -17,7 +17,7 @@ src/app.ts",
    );
    act(() => handle.dispose());
  });

  it("folds viewed rows from progress and unfolds them when setProgress clears them", async () => {
    const { factory, container, spec } = harness();
    const progress = (viewedTo: number): ReviewDiffProgress => ({
      files: [
        {
          path: "src/app.ts",
          state: "partial",
          remaining: { additions: 1, deletions: 1 },
          total: { additions: 1, deletions: 1 },
          viewedRanges: viewedTo
            ? [{ file: "src/app.ts", side: "head", fromLine: 13, toLine: viewedTo }]
            : [],
          changedRanges: [{ file: "src/app.ts", side: "head", fromLine: 20, toLine: 20 }],
        },
      ],
    });
    const handle = factory.create(
      spec({ ranges: [{ startLine: 15, endLine: 25 }], progress: progress(17) }),
    );
    const gaps = () =>
      [...container.querySelectorAll("[data-wb-gap]")].map((gap) => gap.textContent);

    await settle();
    expect(gaps()).toEqual([
      "⋯Outside lens · 11 lines",
      "⋯Viewed · 5 lines",
      "⋯Outside lens · 12 lines",
    ]);
    expect(container.querySelector(".review-multidiff-counts")?.textContent).toBe("+1 −1");

    act(() => handle.setProgress?.(progress(0)));
    expect(gaps()).toEqual(["⋯Outside lens · 11 lines", "⋯Outside lens · 12 lines"]);
    act(() => handle.dispose());
  });

  it("reads each side at the right file across rename, add and delete", async () => {
    const { factory, requests, container, spec } = harness();
    const files = () =>
      requests
        .filter((url) => url.includes("/file?"))
        .map((url) => {
          const params = new URLSearchParams(url.split("?")[1]);

          return `${params.get("side")}:${params.get("file")}@${params.get("version")}`;
        });

    const renamed = factory.create(
      spec({ path: "src/old.ts", side: "base", ranges: [{ startLine: 1, endLine: 2 }] }),
    );

    await settle();
    expect(files()).toEqual(["head:src/new.ts@3", "base:src/old.ts@3"]);
    expect(container.querySelector(".review-path-label")?.textContent).toBe("src/new.ts");
    act(() => renamed.dispose());

    requests.length = 0;
    const added = factory.create(
      spec({ path: "src/added.ts", ranges: [{ startLine: 1, endLine: 2 }] }),
    );

    await settle();
    expect(files()).toEqual(["head:src/added.ts@3"]);
    act(() => added.dispose());

    requests.length = 0;
    const deleted = factory.create(
      spec({ path: "src/gone.ts", side: "base", ranges: [{ startLine: 1, endLine: 2 }] }),
    );

    await settle();
    expect(files()).toEqual(["base:src/gone.ts@3"]);
    expect(container.querySelector("[data-testid=pierre]")?.textContent).toBe(
      "@@ -1,2 +0,0 @@ src/gone.ts",
    );
    act(() => deleted.dispose());
  });

  it("emits editorSelectionChanged with the side's file, side and range", async () => {
    const { factory, spec, emitted } = harness();
    const handle = factory.create(
      spec({ path: "src/old.ts", side: "base", ranges: [{ startLine: 1, endLine: 2 }] }),
    );

    await settle();
    const onLineSelected = pierre.options.at(-1)!.onLineSelected as (range: unknown) => void;

    act(() => onLineSelected({ start: 2, end: 2, side: "deletions" }));
    act(() => onLineSelected({ start: 1, end: 2, side: "additions" }));

    expect(
      emitted.map(
        (event) =>
          event.event === "editorSelectionChanged" && [
            event.path,
            event.sideContext,
            event.range,
            event.apiSource,
          ],
      ),
    ).toEqual([
      ["src/old.ts", "base", { fromLine: 2, toLine: 2 }, { reviewId: "r1", version: 3 }],
      ["src/new.ts", "head", { fromLine: 1, toLine: 2 }, { reviewId: "r1", version: 3 }],
    ]);
    act(() => handle.dispose());
  });

  it("resolves an in-flight setFindQuery with no matches when the peek is disposed", async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, spec } = harness({ hold });
    const handle = factory.create(spec());
    const pending = handle.setFindQuery(query("line 2"));

    // The file list is read; both sides are still loading.
    await settle();
    act(() => handle.dispose());
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);

    release();
    expect(outcome).toEqual({ matchCount: 0 });
  });

  it("reports a read failure through onDidError", async () => {
    const { factory, spec } = harness();
    const errors: string[] = [];
    const handle = factory.create(
      spec({ path: "docs/missing.md", ranges: [{ startLine: 1, endLine: 1 }] }),
    );

    handle.onDidError((message) => errors.push(message));
    await settle();
    expect(errors).toEqual(["missing head:docs/missing.md"]);
    act(() => handle.dispose());
  });
});
