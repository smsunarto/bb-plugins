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
afterEach(cleanup);
const files = [
  { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
  { path: "src/b.ts", status: "modified", additions: 2, deletions: 1 },
];
const fileProgress = (path: string, state: "unread" | "viewed" = "unread") => ({
  path,
  state,
  remaining: { additions: state === "viewed" ? 0 : 1, deletions: state === "viewed" ? 0 : 1 },
  total: { additions: 1, deletions: 1 },
  viewedRanges: [],
  changedRanges: [],
});
function setup(overrides: Partial<ReviewDiffViewSpec> = {}, failed = false) {
  const container = document.body.appendChild(document.createElement("div"));
  const fileTreeContainer = document.body.appendChild(document.createElement("div"));
  const portals = createPortals();
  const request = vi.fn(async (value: string) => {
    const url = new URL(value);
    if (failed) return Response.json({ error: "boom" }, { status: 500 });
    return Response.json(
      url.pathname.endsWith("/diff")
        ? files
        : {
            text: url.searchParams.get("side") === "base" ? "old\n" : "new\n",
            localPath: "/repo/src/a.ts",
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
    fireEvent.click(
      within(fileTreeContainer).getByRole("checkbox", { name: "Mark viewed: src/a.ts" }),
    );
    expect(toggleViewed).toHaveBeenCalledWith("src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
    expect(openFile).toHaveBeenCalledWith({
      reviewId: "r1",
      version: 3,
      generation: "g1",
      path: "src/a.ts",
      pins: undefined,
    });
    act(() =>
      handle.setProgress?.({ files: files.map((file) => fileProgress(file.path, "viewed")) }),
    );
    expect(
      screen
        .getAllByRole<HTMLInputElement>("checkbox", { name: "Mark unviewed: src/a.ts" })
        .every((input) => input.checked),
    ).toBe(true);
    expect(screen.getByTestId("bb-diff:src/a.ts")).toBeTruthy();
    expect(within(container).getAllByText("Viewed")).toHaveLength(2);
    act(() => handle.dispose());
    expect(container.innerHTML).toBe("");
    expect(fileTreeContainer.innerHTML).toBe("");
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
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });
  it("keeps commit comparison headers read only and sends commit scope to every read", async () => {
    const { request, factory, openFile } = setup({ scope: { commit: "abc" } });
    await screen.findByTestId("bb-diff:src/a.ts");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(screen.getAllByText("Read only")).toHaveLength(2);
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
    const { handle } = setup({}, true);
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
