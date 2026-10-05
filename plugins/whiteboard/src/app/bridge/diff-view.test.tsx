// @vitest-environment jsdom
import type { DiffProps, SourceCodeProps } from "@get-bb/plugin-sdk/app";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiffView } from "./diff-view.tsx";
import { createPortals, PortalHost } from "./portals.tsx";
import { setDiffLayout } from "./theme.ts";
import type {
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffViewSpec,
} from "../../shared/vendor/review-protocol/src/index.ts";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Diff: (props: DiffProps) => (
    <pre data-testid={`bb-diff:${props.path}`} data-view={props.view}>
      {props.patch}
    </pre>
  ),
  experimental_SourceCode: (props: SourceCodeProps) => (
    <pre data-testid={`bb-source:${props.path}`}>{props.content}</pre>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const files = [
  { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
  { path: "src/b.ts", status: "modified", additions: 2, deletions: 1 },
];
const fileProgress = (path: string, state: "unread" | "viewed" | "folded" = "unread") => ({
  path,
  state,
  remaining: { additions: state === "unread" ? 1 : 0, deletions: state === "unread" ? 1 : 0 },
  total: { additions: 1, deletions: 1 },
  viewedRanges: [],
  changedRanges: [],
});
const pathTitle = (container: HTMLElement, path: string) =>
  container.querySelector(`[data-wb-path="${path}"] .review-path-label`)?.getAttribute("title");
const fileReads = (request: { mock: { calls: string[][] } }, path: string) =>
  request.mock.calls.filter(([url]) => new URL(url).searchParams.get("file") === path).length;
function setup(
  overrides: Partial<ReviewDiffViewSpec> = {},
  { failed = false, base = "old\n", head = "new\n" } = {},
) {
  const container = document.body.appendChild(document.createElement("div"));
  const fileTreeContainer = document.body.appendChild(document.createElement("div"));
  const portals = createPortals();
  const request = vi.fn(async (value: string) => {
    const url = new URL(value);
    const query = url.searchParams;
    if (failed) return Response.json({ error: "boom" }, { status: 500 });
    // Vendored http.ts names a live path only for current head bytes without commit or pins.
    const live =
      query.get("side") === "head" &&
      !["commit", "repositoryId", "base", "head"].some((key) => query.has(key)) &&
      (!query.has("version") || query.has("generation"));
    return Response.json(
      url.pathname.endsWith("/diff")
        ? files
        : {
            text: query.get("side") === "base" ? base : head,
            ...(live ? { localPath: `/repo/${query.get("file")}` } : {}),
          },
    );
  });
  const openFile = vi.fn(async () => true);
  const toggleViewed = vi.fn();
  const factory = createDiffView({
    request,
    reviewId: "r1",
    portals,
    openFile,
    sourceView: () => ({ reviewId: "r1", version: 3, generation: "g1" }),
  });
  const handle = factory.create({
    container,
    fileTreeContainer,
    onToggleViewed: toggleViewed,
    progress: { files: files.map((file) => fileProgress(file.path)) },
    ...overrides,
  });
  render(<PortalHost portals={portals} />);
  return { handle, factory, request, container, fileTreeContainer, openFile, toggleViewed };
}
describe("bb Diffs view", () => {
  it("renders SDK viewers, counts, viewed controls, file scrolling and open actions", async () => {
    const { handle, fileTreeContainer, container, toggleViewed, openFile } = setup();
    await screen.findByTestId("bb-diff:src/a.ts");
    await screen.findByTestId("bb-diff:src/b.ts");
    expect(fileTreeContainer.textContent).toContain("+1 −1");
    const scroll = vi.fn();
    container.querySelector<HTMLElement>('[data-wb-path="src/b.ts"]')!.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("treeitem", { name: "src/b.ts" }));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(screen.getByRole("treeitem", { name: "src/b.ts" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(within(container).getByRole("checkbox", { name: "Mark viewed: src/a.ts" }));
    expect(toggleViewed).toHaveBeenCalledWith("src/a.ts", undefined);
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(openFile).toHaveBeenCalledWith({
      reviewId: "r1",
      version: 3,
      generation: "g1",
      path: "src/a.ts",
      pins: undefined,
      startLine: 1,
      endLine: 1,
    });
    expect(pathTitle(container, "src/a.ts")).toBe("src/a.ts\nOpen file in File Editor");
    act(() =>
      handle.setProgress?.({ files: files.map((file) => fileProgress(file.path, "viewed")) }),
    );
    expect(within(container).getAllByText("Viewed")).toHaveLength(2);
    act(() => handle.dispose());
    expect(container.innerHTML).toBe("");
    expect(fileTreeContainer.innerHTML).toBe("");
  });
  it("collapses a file when it is marked viewed and on its header, and skips reading closed files", async () => {
    const { handle, container, request, toggleViewed } = setup({
      progress: { files: [fileProgress("src/a.ts"), fileProgress("src/b.ts", "folded")] },
    });
    await screen.findByTestId("bb-diff:src/a.ts");
    const folded = screen.getByRole("button", { name: "Toggle diff: src/b.ts" });
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("bb-diff:src/b.ts")).toBeNull();
    expect(fileReads(request, "src/b.ts")).toBe(0);
    // Unread source gives no read-only reason; a live session stays openable.
    expect(pathTitle(container, "src/b.ts")).toBe("src/b.ts");
    const box = within(container).getByRole("checkbox", { name: "Mark viewed: src/a.ts" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(toggleViewed).toHaveBeenCalledWith("src/a.ts", undefined);
    act(() =>
      handle.setProgress?.({
        files: [fileProgress("src/a.ts", "viewed"), fileProgress("src/b.ts", "folded")],
      }),
    );
    expect(
      within(container)
        .getByRole("checkbox", { name: "Mark unviewed: src/a.ts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByTestId("bb-diff:src/a.ts")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Toggle diff: src/a.ts" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("bb-diff:src/a.ts")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(folded);
    expect(await screen.findByTestId("bb-diff:src/b.ts")).toBeTruthy();
    expect(fileReads(request, "src/b.ts")).toBe(2);
    expect(pathTitle(container, "src/b.ts")).toBe("src/b.ts\nOpen file in File Editor");
  });
  it("scrolls on every reveal request, including the active file again", async () => {
    const { handle, container } = setup();
    await screen.findByTestId("bb-diff:src/b.ts");
    const scroll = vi.fn();
    container.querySelector<HTMLElement>('[data-wb-path="src/a.ts"]')!.scrollIntoView = scroll;
    act(() => handle.revealFile?.("src/a.ts"));
    act(() => handle.revealFile?.("src/a.ts"));
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenLastCalledWith({ block: "start" });
  });
  it("opens a Diffs view file at its first changed line", async () => {
    const base = `${Array.from({ length: 20 }, (_, line) => `line ${line + 1}`).join("\n")}\n`;
    const head = base.replace("line 12\n", "line 12\ninserted\n");
    const { container, openFile } = setup({}, { base, head });
    expect((await screen.findByTestId("bb-diff:src/a.ts")).textContent).toContain(
      "@@ -10,6 +10,7 @@\n line 10\n line 11\n line 12\n+inserted\n",
    );
    fireEvent.click(
      within(container.querySelector<HTMLElement>('[data-wb-path="src/a.ts"]')!).getByRole(
        "button",
        { name: "Open file" },
      ),
    );
    expect(openFile).toHaveBeenCalledWith({
      reviewId: "r1",
      version: 3,
      generation: "g1",
      path: "src/a.ts",
      pins: undefined,
      startLine: 13,
      endLine: 13,
    });
  });
  it("loads a file's diff once it nears the scroller, or when a reveal targets it", async () => {
    const roots: (Element | Document | null | undefined)[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          private readonly callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          roots.push(options?.root);
        }
        observe(target: HTMLElement) {
          this.callback(
            [{ target, isIntersecting: target.dataset.wbPath === "src/a.ts" }] as never,
            this as never,
          );
        }
        disconnect() {}
      },
    );
    const { handle, container, request } = setup();
    await screen.findByTestId("bb-diff:src/a.ts");
    expect(roots).toContain(container);
    expect(screen.queryByTestId("bb-diff:src/b.ts")).toBeNull();
    expect(fileReads(request, "src/b.ts")).toBe(0);
    const scroll = vi.fn();
    container.querySelector<HTMLElement>('[data-wb-path="src/b.ts"]')!.scrollIntoView = scroll;
    act(() => handle.revealFile?.("src/b.ts"));
    expect(await screen.findByTestId("bb-diff:src/b.ts")).toBeTruthy();
    expect(fileReads(request, "src/b.ts")).toBe(2);
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it("renders split diffs inline below Monaco's 900px breakpoint", async () => {
    const resizes: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizes.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    let width = 703;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width, height: 100 }) as DOMRect,
    );
    await act(async () => setDiffLayout("split"));
    setup();
    expect((await screen.findByTestId("bb-diff:src/a.ts")).dataset.view).toBe("unified");
    width = 1200;
    act(() => {
      for (const resize of resizes) resize();
    });
    expect(screen.getByTestId("bb-diff:src/a.ts").dataset.view).toBe("split");
  });
  it("tracks the split/unified choice through the SDK viewer", async () => {
    setup();
    const diff = await screen.findByTestId("bb-diff:src/a.ts");
    await act(async () => setDiffLayout("unified"));
    expect(diff.dataset.view).toBe("unified");
    await act(async () => setDiffLayout("split"));
    expect(diff.dataset.view).toBe("split");
  });
  it("filters a lens at file level using its immutable version", async () => {
    const lens: ReviewDiffLens = {
      id: "l1",
      title: "A",
      reviewId: "r1",
      version: 2,
      ranges: [{ file: "src/a.ts", side: "head", fromLine: 1, toLine: 1 }],
    };
    const { request } = setup({ lens });
    await screen.findByTestId("bb-diff:src/a.ts");
    expect(screen.queryByTestId("bb-diff:src/b.ts")).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "src/b.ts" })).toBeNull();
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("version")).toBe("2");
    expect(request.mock.calls.every(([url]) => !new URL(url).searchParams.has("generation"))).toBe(
      true,
    );
    expect(pathTitle(document.body, "src/a.ts")).toBe(
      "src/a.ts\nThis source is pinned to a commit. bb can open only live worktree files.",
    );
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });
  it("keeps commit comparison headers read only and sends commit scope to every read", async () => {
    const { request, factory, openFile, container } = setup({ scope: { commit: "abc" } });
    await screen.findByTestId("bb-diff:src/a.ts");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(files.map((file) => pathTitle(container, file.path))).toEqual([
      "src/a.ts\nThis source is pinned to a commit. bb can open only live worktree files.",
      "src/b.ts\nThis source is pinned to a commit. bb can open only live worktree files.",
    ]);
    expect(openFile).not.toHaveBeenCalled();
    expect(
      request.mock.calls.every(([url]) => new URL(url).searchParams.get("commit") === "abc"),
    ).toBe(true);
    await factory.files({ commit: "def" });
    expect(new URL(request.mock.calls.at(-1)![0]).searchParams.get("commit")).toBe("def");
  });
  it("preserves section viewed actions and grouped file progress", async () => {
    const lens: ReviewDiffLens = {
      id: "l1",
      title: "A",
      reviewId: "r1",
      version: 3,
      ranges: [{ file: "src/a.ts", side: "head", fromLine: 1, toLine: 1 }],
    };
    const onToggleSection = vi.fn();
    const progress: ReviewDiffProgress = {
      files: [],
      sections: [
        {
          id: "s1",
          label: "Group A",
          sources: lens.ranges,
          state: "unread",
          total: { additions: 1, deletions: 1 },
          remaining: { additions: 1, deletions: 1 },
          files: [fileProgress("src/a.ts")],
        },
      ],
    };
    const { toggleViewed, container } = setup({ lens, progress, onToggleSection });
    await screen.findByTestId("bb-diff:src/a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark viewed: Group A" }));
    expect(onToggleSection).toHaveBeenCalledWith("s1");
    fireEvent.click(within(container).getByRole("checkbox", { name: "Mark viewed: src/a.ts" }));
    expect(toggleViewed).toHaveBeenCalledWith("src/a.ts", "s1");
  });
  it("delivers source read errors and rejects incompatible lens scope", async () => {
    const { handle } = setup({}, { failed: true });
    const error = vi.fn();
    handle.onDidError(error);
    await waitFor(() => expect(error).toHaveBeenCalledWith("boom"));
    act(() => handle.dispose());
    cleanup();
    const invalid = setup({
      scope: { commit: "abc" },
      lens: { id: "l1", title: "L", reviewId: "r1", version: 1, ranges: [] },
    });
    const second = vi.fn();
    invalid.handle.onDidError(second);
    await waitFor(() =>
      expect(second).toHaveBeenCalledWith("A lens must use its review comparison."),
    );
  });
});
