// @vitest-environment jsdom
import type { DiffProps, SourceCodeProps } from "@get-bb/plugin-sdk/app";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineEditors } from "./inline-editors.tsx";
import { createPortals, PortalHost } from "./portals.tsx";
import type {
  ReviewDiffProgressFile,
  ReviewInlineEditorSpec,
} from "../../shared/vendor/review-protocol/src/index.ts";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Diff: (props: DiffProps) => (
    <pre
      data-testid="bb-diff"
      data-view={props.view}
      data-full={JSON.stringify(props.experimental_fullFileContents)}
    >
      {props.patch}
    </pre>
  ),
  experimental_SourceCode: (props: SourceCodeProps) => (
    <pre data-testid="bb-source" data-highlight={JSON.stringify(props.highlightedLines)}>
      {props.content}
    </pre>
  ),
}));
afterEach(cleanup);

const pathTitle = () => document.querySelector(".review-path-label")?.getAttribute("title");
const header = () => document.querySelector(".review-multidiff-header")?.textContent;

function setup(
  input: {
    path?: string;
    title?: string;
    base?: string;
    head?: string;
    comparisonHead?: string;
    status?: "modified" | "added" | "deleted" | "renamed" | "unchanged";
    ranges?: ReviewInlineEditorSpec["ranges"];
    pins?: ReviewInlineEditorSpec["pins"];
    heightMode?: "capped" | "content";
    live?: boolean;
    side?: "base" | "head";
  } = {},
) {
  const container = document.body.appendChild(document.createElement("div"));
  const file = {
    path: input.path ?? "src/a.ts",
    status: input.status ?? "modified",
    additions: 1,
    deletions: 1,
    ...(input.status === "renamed" ? { previousPath: "src/old.ts" } : {}),
  };
  const request = vi.fn(async (value: string) => {
    const url = new URL(value);
    const comparison = url.searchParams.get("projection") === "comparison";
    return Response.json(
      url.pathname.endsWith("/diff")
        ? // The comparison omits unchanged files; the lens adds them as context.
          input.status === "unchanged"
          ? []
          : [file]
        : {
            localPath:
              input.pins ||
              input.live === false ||
              (comparison &&
                input.comparisonHead !== undefined &&
                input.comparisonHead !== input.head)
                ? undefined
                : "/repo/src/a.ts",
            text:
              url.searchParams.get("side") === "base"
                ? (input.base ?? "a\nb\n")
                : ((comparison ? input.comparisonHead : undefined) ?? input.head ?? "a\nB\n"),
          },
    );
  });
  const portals = createPortals();
  const openFile = vi.fn(async () => true);
  const factory = createInlineEditors({
    request,
    portals,
    reviewId: "r1",
    openFile,
    sourceView: () => ({ reviewId: "r1", version: 3, generation: "g" }),
  });
  const spec: ReviewInlineEditorSpec = {
    container,
    path: file.path,
    title: input.title ?? "src/a.ts:2",
    side: input.side ?? "head",
    ranges: input.ranges ?? [{ startLine: 2, endLine: 2 }],
    heightMode: input.heightMode ?? "content",
    active: true,
    ...(input.pins ? { pins: input.pins } : {}),
  };
  const handle = factory.create(spec);
  render(<PortalHost portals={portals} />);
  return { handle, factory, spec, request, openFile, container };
}

describe("bb code peeks", () => {
  it("renders SDK Diff with the complete sides and opens its file in bb", async () => {
    const { handle, openFile, container } = setup();
    const diff = await screen.findByTestId("bb-diff");
    expect(diff.textContent).toContain("-b\n+B");
    expect(JSON.parse(diff.dataset.full!)).toEqual({
      old: { path: "src/a.ts", content: "a\nb\n" },
      new: { path: "src/a.ts", content: "a\nB\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(openFile).toHaveBeenCalledWith({
      reviewId: "r1",
      version: 3,
      generation: "g",
      path: "src/a.ts",
      pins: undefined,
      startLine: 2,
      endLine: 2,
    });
    expect(container.classList.contains("review-document-code-active")).toBe(true);
    act(() => handle.setActive(false));
    expect(container.classList.contains("review-document-code-active")).toBe(false);
    act(() => handle.setCollapsed(true));
    expect(handle.height).toBe(40);
    expect(container.querySelector<HTMLElement>("[data-wb-peek]")?.hidden).toBe(true);
    act(() => handle.setCollapsed(false));
    expect(handle.height).toBeGreaterThan(40);
    act(() => handle.dispose());
    expect(container.innerHTML).toBe("");
  });
  it("frames an unchanged source's range with three lines of context and labels it Unchanged", async () => {
    const path = "infra/k8s/argocd/bootstrap/root.yaml";
    const head = Array.from({ length: 60 }, (_, line) => `key${line + 1}: value`).join("\n") + "\n";
    setup({
      status: "unchanged",
      path,
      title: `${path}:45-55`,
      head,
      ranges: [{ startLine: 45, endLine: 55 }],
    });
    const diff = await screen.findByTestId("bb-diff");
    expect(diff.dataset.view).toBe("unified");
    expect(diff.textContent).toBe(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -42,17 +42,17 @@\n${Array.from(
        { length: 17 },
        (_, line) => ` key${line + 42}: value\n`,
      ).join("")}`,
    );
    expect(JSON.parse(diff.dataset.full!)).toEqual({
      old: { path, content: head },
      new: { path, content: head },
    });
    expect(screen.queryByTestId("bb-source")).toBeNull();
    expect(document.querySelector(".review-path-label")?.textContent).toBe(`${path}:45-55`);
    expect(header()).toContain("Unchanged");
    expect(header()).not.toContain("+0");
    expect(screen.getByText("Unchanged").closest("[title]")?.getAttribute("title")).toBe(
      "Referenced context; no changed lines",
    );
  });
  it("shows the peek's lens progress counts and hides counts without progress", async () => {
    const { handle, request } = setup();
    const diff = await screen.findByTestId("bb-diff");
    const reads = request.mock.calls.length;
    expect(header()).not.toMatch(/[+−]\d/);
    const progress: ReviewDiffProgressFile = {
      path: "src/a.ts",
      state: "partial",
      remaining: { additions: 2, deletions: 1 },
      total: { additions: 3, deletions: 1 },
      viewedRanges: [],
      changedRanges: [],
    };
    act(() => handle.setProgress?.({ files: [progress] }));
    expect(header()).toContain("+2 −1");
    // Progress re-renders the header only: the source neither reloads nor remounts.
    expect(screen.getByTestId("bb-diff")).toBe(diff);
    expect(request).toHaveBeenCalledTimes(reads);
    act(() => handle.setProgress?.({ files: [] }));
    expect(header()).not.toMatch(/[+−]\d/);
    expect(screen.getByTestId("bb-diff")).toBe(diff);
    expect(request).toHaveBeenCalledTimes(reads);
  });
  it("frames every range of a multi-range peek in its own context hunk", async () => {
    const head = Array.from({ length: 100 }, (_, line) => `line ${line + 1}`).join("\n") + "\n";
    setup({
      status: "unchanged",
      head,
      ranges: [
        { startLine: 10, endLine: 20 },
        { startLine: 80, endLine: 90 },
      ],
    });
    const diff = await screen.findByTestId("bb-diff");
    expect(diff.textContent!.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -7,17 +7,17 @@",
      "@@ -77,17 +77,17 @@",
    ]);
  });
  it("uses canonical comparison rows and keeps transformed Diff source read only", async () => {
    const { request } = setup({
      base: "EXPORT CONST A = 10;\nEXPORT CONST A2 = 20;\n",
      head: "export const a = 11;\nexport const a2 = 20;\n",
      comparisonHead: "EXPORT CONST A = 11;\nEXPORT CONST A2 = 20;\n",
    });
    const diff = await screen.findByTestId("bb-diff");
    expect(diff.textContent!.split("\n").filter((line) => /^[+-](?![+-])/.test(line))).toEqual([
      "-EXPORT CONST A = 10;",
      "+EXPORT CONST A = 11;",
    ]);
    expect(JSON.parse(diff.dataset.full!).new.content).toBe(
      "EXPORT CONST A = 11;\nEXPORT CONST A2 = 20;\n",
    );
    expect(pathTitle()).toBe(
      "src/a.ts:2\nThis source is pinned to a commit. bb can open only live worktree files.",
    );
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(
      request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .every(([url]) => new URL(url).searchParams.get("projection") === "comparison"),
    ).toBe(true);
  });
  it("uses exact raw source for unchanged files and peeks outside canonical hunks", async () => {
    const baseline =
      Array.from({ length: 15 }, (_, line) => `EXPORT CONST A${line} = 10;`).join("\n") + "\n";
    const canonical = baseline.replace("A0 = 10", "A0 = 11");
    const raw = canonical.toLowerCase();
    const { request, openFile, handle } = setup({
      base: baseline,
      head: raw,
      comparisonHead: canonical,
      ranges: [{ startLine: 15, endLine: 15 }],
    });
    const outside = await screen.findByTestId("bb-diff");
    expect(JSON.parse(outside.dataset.full!).new).toEqual({ path: "src/a.ts", content: raw });
    expect(outside.textContent).toContain(
      "@@ -12,4 +12,4 @@\n export const a11 = 10;\n export const a12 = 10;\n export const a13 = 10;\n export const a14 = 10;\n",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(openFile).toHaveBeenCalledWith({
      reviewId: "r1",
      version: 3,
      generation: "g",
      path: "src/a.ts",
      pins: undefined,
      startLine: 15,
      endLine: 15,
    });
    expect(
      request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(([url]) => new URL(url).searchParams.get("projection")),
    ).toEqual(["comparison", "comparison", null]);
    act(() => handle.dispose());
    cleanup();
    const unchanged = setup({ status: "unchanged", head: raw, comparisonHead: canonical });
    const context = await screen.findByTestId("bb-diff");
    expect(JSON.parse(context.dataset.full!).new).toEqual({ path: "src/a.ts", content: raw });
    expect(context.textContent).toContain("@@ -1,5 +1,5 @@\n export const a0 = 11;\n");
    expect(
      unchanged.request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(([url]) => new URL(url).searchParams.get("projection")),
    ).toEqual([null]);
  });
  it("keeps explicit commit pins read only and skips the diff request without a base", async () => {
    const { request, openFile } = setup({ pins: { repositoryId: "repo1", head: "commit" } });
    expect((await screen.findByTestId("bb-diff")).dataset.view).toBe("unified");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(pathTitle()).toBe(
      "src/a.ts:2\nThis source is pinned to a commit. bb can open only live worktree files.",
    );
    expect(header()).not.toMatch(/[+−]\d/);
    expect(openFile).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([url]) => !url.includes("/diff?"))).toBe(true);
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("head")).toBe("commit");
  });
  it("keeps retained-only source read only when the file response has no live path", async () => {
    setup({ live: false });
    await screen.findByTestId("bb-diff");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(pathTitle()).toBe(
      "src/a.ts:2\nThis source is pinned to a commit. bb can open only live worktree files.",
    );
  });
  it.each([
    { side: "base" as const, ranges: [{ startLine: 2, endLine: 2 }] },
    { side: "head" as const, ranges: [{ startLine: 2, endLine: 2, side: "base" as const }] },
  ])("keeps base-only peek ranges read only even when a live head exists: %j", async (input) => {
    const { openFile } = setup(input);
    await screen.findByTestId("bb-diff");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(pathTitle()).toBe("src/a.ts:2\nBase source is read only.");
    expect(openFile).not.toHaveBeenCalled();
  });
  it("keeps Monaco find methods inert without requesting additional source", async () => {
    const { factory, handle, spec, request } = setup();
    await screen.findByTestId("bb-diff");
    const reads = request.mock.calls.length;
    const query = { text: "B", matchCase: false, wholeWord: false, isRegex: false };
    expect(await factory.find(spec, query)).toEqual({ matchCount: 0 });
    expect(await handle.setFindQuery(query)).toEqual({ matchCount: 0 });
    handle.revealFindMatch(0);
    handle.clearActiveFindMatch();
    handle.clearFind();
    expect(request).toHaveBeenCalledTimes(reads);
  });
  it("reads only the existing side of additions and deletions, and the prior rename path", async () => {
    const added = setup({ status: "added" });
    await screen.findByTestId("bb-diff");
    expect(
      added.request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(([url]) => new URL(url).searchParams.get("side")),
    ).toEqual(["head"]);
    act(() => added.handle.dispose());
    cleanup();
    const deleted = setup({
      status: "deleted",
      ranges: [{ startLine: 2, endLine: 2, side: "base" }],
    });
    await screen.findByTestId("bb-diff");
    // A deletion has no live file, so its title gives no read-only reason.
    expect(pathTitle()).toBe("src/a.ts:2");
    expect(
      deleted.request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(([url]) => new URL(url).searchParams.get("side")),
    ).toEqual(["base"]);
    act(() => deleted.handle.dispose());
    cleanup();
    const renamed = setup({ status: "renamed" });
    await screen.findByTestId("bb-diff");
    expect(
      renamed.request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(
          ([url]) =>
            `${new URL(url).searchParams.get("side")}:${new URL(url).searchParams.get("file")}`,
        ),
    ).toEqual(["head:src/a.ts", "base:src/old.ts"]);
  });
  it("reports measured height changes and respects the cap", async () => {
    let observer: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observer = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { handle, container } = setup({ heightMode: "capped" });
    await screen.findByTestId("bb-diff");
    const changed = vi.fn();
    handle.onDidChangeHeight(changed);
    const element = container.querySelector<HTMLElement>("[data-wb-path]")!;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ height: 800 } as DOMRect);
    act(() => observer?.());
    await waitFor(() => expect(handle.height).toBe(400));
    expect(changed).toHaveBeenCalledWith(400);
    vi.unstubAllGlobals();
  });
});
