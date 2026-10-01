// @vitest-environment jsdom
import type { DiffProps, SourceCodeProps } from "@get-bb/plugin-sdk/app";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineEditors } from "./inline-editors.tsx";
import { createPortals, PortalHost } from "./portals.tsx";
import type { ReviewInlineEditorSpec } from "../../shared/vendor/review-protocol/src/index.ts";

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

function setup(
  input: {
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
    path: "src/a.ts",
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
        ? [file]
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
    title: "a.ts",
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
  it("renders unchanged source with the range highlighted", async () => {
    setup({ base: "a\nb\n", head: "a\nb\n" });
    expect((await screen.findByTestId("bb-source")).dataset.highlight).toBe('{"start":2,"end":2}');
    expect(screen.queryByTestId("bb-diff")).toBeNull();
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
    expect(screen.getByText("Read only")).toBeTruthy();
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
    expect((await screen.findByTestId("bb-source")).textContent).toBe(raw);
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
    expect((await screen.findByTestId("bb-source")).textContent).toBe(raw);
    expect(
      unchanged.request.mock.calls
        .filter(([url]) => url.includes("/file?"))
        .map(([url]) => new URL(url).searchParams.get("projection")),
    ).toEqual([null]);
  });
  it("keeps explicit commit pins read only and skips the diff request without a base", async () => {
    const { request, openFile } = setup({ pins: { repositoryId: "repo1", head: "commit" } });
    await screen.findByTestId("bb-source");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(openFile).not.toHaveBeenCalled();
    expect(request.mock.calls.every(([url]) => !url.includes("/diff?"))).toBe(true);
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("head")).toBe("commit");
  });
  it("keeps retained-only source read only when the file response has no live path", async () => {
    setup({ live: false });
    await screen.findByTestId("bb-diff");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
  });
  it.each([
    { side: "base" as const, ranges: [{ startLine: 2, endLine: 2 }] },
    { side: "head" as const, ranges: [{ startLine: 2, endLine: 2, side: "base" as const }] },
  ])("keeps base-only peek ranges read only even when a live head exists: %j", async (input) => {
    const { openFile } = setup(input);
    await screen.findByTestId("bb-diff");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
    expect(screen.getByText("Read only")).toBeTruthy();
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
    handle.setProgress?.({ files: [] });
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
