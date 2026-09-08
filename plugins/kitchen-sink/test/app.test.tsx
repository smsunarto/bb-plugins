import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { fireEvent, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { parsePatchFiles } from "@pierre/diffs";

installDom();
if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    configurable: true,
    value() {},
  });
}
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { embedCache } = await import("../src/app/embed-cache.ts");
const { WORKSPACE_CHANGED_CHANNEL } = await import("../src/shared/contract.ts");

const patch =
  "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("reserves room for 100 monospace columns without exceeding the viewport", async () => {
  const stylesheet = await readFile(new URL("../src/app/app.css", import.meta.url), "utf8");
  expect(stylesheet).toContain("--smart-embed-target-width: calc(100ch + 8rem + 4px)");
  expect(stylesheet).toContain("calc(100vw - 2rem)");
  expect(stylesheet).toContain("transform: translateX(-50%)");
});

test("registers the smart embeds and inline visualization directives", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives.map((directive) => directive.id)).toEqual([
    "smart-diff",
    "smart-code",
    "smart-patch",
    "inline-vis",
  ]);
});

const inlineVisMessage = {
  id: "message-inline-vis",
  threadId: "thread-inline-vis",
  turnId: "turn-inline-vis",
  projectId: "project-inline-vis",
};

async function inlineVisDirective() {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "inline-vis");
  expect(directive).toBeDefined();
  return directive!;
}

test("inline-vis requires a file attribute without calling RPC", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: {},
      source: "::inline-vis{}",
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/requires a file attribute/i);
  expect(slot.rpcCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis uses the worktree route with an opaque-origin script sandbox", async () => {
  const directive = await inlineVisDirective();
  const openWorkspaceFile = mock(() => true);
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "charts/demo file.html" },
      source: '::inline-vis{file="charts/demo file.html"}',
      message: inlineVisMessage,
      openWorkspaceFile,
    },
    {
      rpc: {
        prepareHtmlPreview: (input) => {
          expect(input).toEqual({
            threadId: "thread-inline-vis",
            file: "charts/demo file.html",
          });
          return { file: "charts/demo file.html" };
        },
      },
    },
  );

  await slot.findByRole("status", {
    name: "Loading visualization charts/demo file.html",
  });
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element).toBeTruthy();
    return element as HTMLIFrameElement;
  });

  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  expect(iframe.getAttribute("src")).toBe(
    "/api/v1/threads/thread-inline-vis/worktree/files/charts/demo%20file.html",
  );
  expect(iframe.getAttribute("srcdoc")).toBeNull();
  expect(iframe.style.height).toBe("224px");
  fireEvent.click(slot.getByRole("button", { name: "Open charts/demo file.html in sidebar" }));
  expect(openWorkspaceFile).toHaveBeenCalledWith("charts/demo file.html");
  expect(slot.rpcCalls).toEqual([
    {
      method: "prepareHtmlPreview",
      input: { threadId: "thread-inline-vis", file: "charts/demo file.html" },
    },
  ]);
  slot.unmount();
});

test("inline-vis uses an optional bounded height and reserves it while loading", async () => {
  const directive = await inlineVisDirective();
  let resolvePreview = (_result: { file: string }) => {};
  const pendingPreview = new Promise<{ file: string }>((resolve) => {
    resolvePreview = resolve;
  });
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "demo.html", height: "480" },
      source: '::inline-vis{file="demo.html" height="480"}',
      message: inlineVisMessage,
      openWorkspaceFile: mock(() => true),
    },
    { rpc: { prepareHtmlPreview: () => pendingPreview } },
  );

  const loading = await slot.findByRole("status", { name: "Loading visualization demo.html" });
  expect((loading as HTMLElement).style.height).toBe("480px");
  const loadingCard = loading.parentElement!;
  const loadingHeader = loadingCard.firstElementChild!;
  expect(loadingHeader.querySelector(".inline-vis-action-placeholder")).toBeTruthy();

  resolvePreview({ file: "demo.html" });
  const iframe = await waitFor(() => {
    const element = slot.container.querySelector("iframe");
    expect(element).toBeTruthy();
    return element as HTMLIFrameElement;
  });
  expect(iframe.style.height).toBe("480px");
  expect(iframe.parentElement).toBe(loadingCard);
  expect(iframe.parentElement?.firstElementChild?.className).toBe(loadingHeader.className);
  slot.unmount();
});

test("inline-vis rejects invalid heights without calling RPC", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "demo.html", height: "100vh" },
      source: '::inline-vis{file="demo.html" height="100vh"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    { rpc: {} },
  );

  expect(slot.getByRole("alert").textContent).toMatch(/whole number from 120 to 1200 pixels/i);
  expect(slot.container.querySelector("iframe")).toBeNull();
  expect(slot.rpcCalls).toEqual([]);
  slot.unmount();
});

test("inline-vis reports RPC failures without mounting an iframe", async () => {
  const directive = await inlineVisDirective();
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "missing.html" },
      source: '::inline-vis{file="missing.html"}',
      message: inlineVisMessage,
      openWorkspaceFile: null,
    },
    {
      rpc: {
        prepareHtmlPreview: () => {
          throw new Error("HTML file not found: missing.html");
        },
      },
    },
  );

  const alert = await slot.findByRole("alert");
  expect(alert.textContent).toMatch(/HTML file not found: missing\.html/);
  expect(slot.container.querySelector("iframe")).toBeNull();
  slot.unmount();
});

test("renders a proposed patch from thread storage with its own header label", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-patch");
  expect(directive).toBeDefined();
  const slot = renderSlot(
    directive!,
    {
      attributes: { file: "proposal.patch", path: "src/example.ts" },
      source: '::smart-patch{file="proposal.patch" path="src/example.ts"}',
      message: {
        id: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        projectId: "project-1",
      },
      openWorkspaceFile: null,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready" as const,
          kind: "patch" as const,
          path: "src/example.ts",
          label: "src/example.ts",
          patch,
          truncated: false,
        }),
      },
    },
  );
  const diff = await slot.findByTestId("bb-diff");
  expect(diff.dataset.path).toBe("src/example.ts");
  expect(slot.getByText("Proposed")).toBeDefined();
  expect(slot.rpcCalls[0]?.input).toEqual({
    kind: "patch",
    threadId: "thread-1",
    path: "src/example.ts",
    file: "proposal.patch",
  });
  slot.unmount();
  embedCache.clear();
});

test("a smart patch without a file reports the missing attribute instead of calling the server", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-patch");
  const slot = renderSlot(
    directive!,
    {
      attributes: {},
      source: "::smart-patch",
      message: { id: "m", threadId: "thread-1", turnId: "t", projectId: "p" },
      openWorkspaceFile: null,
    },
    { rpc: { renderEmbed: async () => readyDiff(patch) } },
  );
  expect(
    slot.getByText("This Smart Embed needs a thread-storage-relative patch file."),
  ).toBeDefined();
  expect(slot.rpcCalls).toEqual([]);
  slot.unmount();
});

function readyDiff(patchText: string) {
  return {
    status: "ready" as const,
    kind: "diff" as const,
    path: "src/example.ts",
    label: "src/example.ts",
    patch: patchText,
    truncated: false,
  };
}

async function renderDiffEmbed(
  renderEmbed: () => Promise<import("../src/shared/contract.ts").RenderEmbedOutput>,
) {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-diff");
  expect(directive).toBeDefined();
  return renderSlot(
    directive!,
    {
      attributes: { path: "src/example.ts" },
      source: '::smart-diff{path="src/example.ts"}',
      message: {
        id: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        projectId: "project-1",
      },
      openWorkspaceFile: null,
    },
    { rpc: { renderEmbed } },
  );
}

test("labels a non-Git diff preview as current code", async () => {
  embedCache.clear();
  const slot = await renderDiffEmbed(async () => ({
    status: "ready",
    kind: "code",
    path: "src/example.ts",
    label: "src/example.ts:L99-L100",
    content: "const value = 1;\nreturn value;",
    startLine: 99,
    truncated: false,
  }));
  const diff = await slot.findByTestId("bb-diff");
  expect(diff.textContent).toBe("@@ -99,2 +99,2 @@\n const value = 1;\n return value;\n");
  expect(diff.dataset.path).toBe("src/example.ts");
  expect(slot.getByText("Code")).toBeDefined();
  expect(slot.getByText("No Git history. Showing current code.")).toBeDefined();
  expect(slot.queryByText("Changes")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("serves a remount from the cache without a loading state or a second RPC call", async () => {
  embedCache.clear();
  const first = await renderDiffEmbed(async () => readyDiff(patch));
  await first.findByTestId("bb-diff");
  expect(first.rpcCalls.map((call) => call.method)).toEqual(["renderEmbed"]);
  expect(first.rpcCalls[0]?.input).toEqual({
    kind: "diff",
    threadId: "thread-1",
    messageId: "message-1",
    path: "src/example.ts",
  });
  first.unmount();

  const second = await renderDiffEmbed(async () => readyDiff(patch));
  expect(second.queryByText("Loading src/example.ts…")).toBeNull();
  expect(second.getByTestId("bb-diff")).toBeDefined();
  expect(second.rpcCalls).toEqual([]);
  second.unmount();
  embedCache.clear();
});

test("refetches in place when the server reports the thread's workspace changed", async () => {
  embedCache.clear();
  let version = 0;
  const slot = await renderDiffEmbed(async () => {
    version += 1;
    return readyDiff(`${patch}# v${version}\n`);
  });
  const before = await slot.findByTestId("bb-diff");
  expect(before.textContent).toContain("# v1");

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "other", reason: "idle" });
  expect(slot.rpcCalls).toHaveLength(1);

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "thread-1", reason: "idle" });
  await slot.findByText((_, node) => node?.textContent?.includes("# v2") === true, {
    selector: "pre",
  });
  expect(slot.rpcCalls).toHaveLength(2);
  expect(slot.queryByText("Loading src/example.ts…")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("frees the thread's entries when it is deleted and refetches after a reconnect", async () => {
  embedCache.clear();
  const slot = await renderDiffEmbed(async () => readyDiff(patch));
  await slot.findByTestId("bb-diff");
  expect(embedCache.size).toBe(1);

  await slot.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { threadId: "thread-1", reason: "deleted" });
  // The entry is freed; the still-mounted embed starts over with a fresh fetch.
  await slot.findByTestId("bb-diff");
  expect(slot.rpcCalls).toHaveLength(2);

  await slot.setRealtimeConnectionState("reconnecting");
  await slot.setRealtimeConnectionState("connected");
  await slot.findByTestId("bb-diff");
  expect(slot.rpcCalls).toHaveLength(3);
  slot.unmount();
  embedCache.clear();
});

test("renders through bb's themed diff component and opens its workspace file", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-diff");
  expect(directive).toBeDefined();
  const openWorkspaceFile = mock(() => true);
  const slot = renderSlot(
    directive!,
    {
      attributes: { path: "src/example.ts" },
      source: '::smart-diff{path="src/example.ts"}',
      message: {
        id: "message-1",
        threadId: "thread-1",
        turnId: "turn-1",
        projectId: "project-1",
      },
      openWorkspaceFile,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready" as const,
          kind: "diff" as const,
          path: "src/example.ts",
          label: "src/example.ts",
          patch,
          truncated: false,
        }),
      },
    },
  );

  const open = await slot.findByRole("button", {
    name: "Open src/example.ts in the workspace",
  });
  const diff = await slot.findByTestId("bb-diff");
  expect(diff.dataset.path).toBe("src/example.ts");
  expect(diff.dataset.view).toBe("unified");
  expect(diff.dataset.overflow).toBe("scroll");
  expect(diff.dataset.showLineNumbers).toBe("true");
  open.click();
  expect(openWorkspaceFile).toHaveBeenCalledWith("src/example.ts");
  slot.unmount();
});

test("keeps the diff viewport mounted while a deferred request resolves or fails", async () => {
  for (const output of [readyDiff(patch), { status: "error" as const, message: "Unavailable" }]) {
    embedCache.clear();
    let resolve!: (value: typeof output) => void;
    const response = new Promise<typeof output>((done) => {
      resolve = done;
    });
    const slot = await renderDiffEmbed(() => response);
    const loading = slot.getByText("Loading src/example.ts…");
    const frame = loading.closest("figure")!;
    const body = loading.closest(".smart-embed-body")!;
    expect(frame.classList.contains("smart-embed-fixed")).toBe(true);
    expect(frame.getAttribute("aria-busy")).toBe("true");
    resolve(output);
    if (output.status === "ready") await slot.findByTestId("bb-diff");
    else await slot.findByText("Unavailable");
    expect(slot.container.querySelector("figure")).toBe(frame);
    expect(slot.container.querySelector(".smart-embed-body")).toBe(body);
    expect(frame.classList.contains("smart-embed-fixed")).toBe(true);
    slot.unmount();
  }
  embedCache.clear();
});

for (const { startLine, content } of [
  { startLine: 1, content: "const first = 1;" },
  { startLine: 42, content: "  const spaced = 1;  \n\t  \n" },
  { startLine: 400, content: "const first = 1;\r\nconst next = 2;\r\n  " },
]) {
  test(`renders source excerpts as unchanged context at line ${startLine}`, async () => {
    embedCache.clear();
    const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
    const directive = captured.messageDirectives.find((item) => item.id === "smart-code");
    const path = "src/space dir/example.ts";
    const openWorkspaceFile = mock(() => true);
    const slot = renderSlot(
      directive!,
      {
        attributes: { path, start: String(startLine) },
        source: "::smart-code",
        message: { id: "source-m", threadId: "source-t", turnId: "t", projectId: "p" },
        openWorkspaceFile,
      },
      {
        rpc: {
          renderEmbed: async () => ({
            status: "ready",
            kind: "code",
            path,
            label: path,
            content,
            startLine,
            truncated: true,
          }),
        },
      },
    );
    const diff = await slot.findByTestId("bb-diff");
    expect(diff.dataset.path).toBe(path);
    expect(diff.dataset.showLineNumbers).toBe("true");
    const patchText = diff.textContent!;
    expect(patchText.startsWith("@@ ")).toBe(true);
    expect(
      patchText
        .split("\n")
        .slice(1, -1)
        .map((line) => line.slice(1))
        .join("\n"),
    ).toBe(content);
    const file = parsePatchFiles(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patchText}`,
    )[0]!.files[0]!;
    expect(file.name).toBe(path);
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]).toMatchObject({
      additionStart: startLine,
      deletionStart: startLine,
      additionCount: content.split("\n").length,
      deletionCount: content.split("\n").length,
      additionLines: 0,
      deletionLines: 0,
    });
    expect(slot.getByText("Truncated")).toBeDefined();
    slot.getByRole("button", { name: `Open ${path} in the workspace` }).click();
    expect(openWorkspaceFile).toHaveBeenCalledWith(path);
    slot.unmount();
    embedCache.clear();
  });
}

test("keeps empty non-Git source readable without an empty diff", async () => {
  embedCache.clear();
  const slot = await renderDiffEmbed(async () => ({
    status: "ready",
    kind: "code",
    path: "src/example.ts",
    label: "src/example.ts",
    content: "",
    startLine: 1,
    truncated: false,
  }));
  await slot.findByText("Empty source.");
  expect(slot.getByText("No Git history. Showing current code.")).toBeDefined();
  expect(slot.queryByTestId("bb-diff")).toBeNull();
  slot.unmount();
  embedCache.clear();
});
