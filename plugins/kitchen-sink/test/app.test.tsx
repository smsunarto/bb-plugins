import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { readFile } from "node:fs/promises";
import { parsePatchFiles } from "@pierre/diffs";

installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
if (typeof CSSStyleSheet.prototype.replaceSync !== "function") {
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    configurable: true,
    value() {},
  });
}
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { embedCache } = await import("../src/app/embed-cache.ts");
const { WORKSPACE_CHANGED_CHANNEL } = await import("../src/shared/contract.ts");

const patch = "const example = 1;";

test("reserves room for 100 monospace columns without exceeding the message width", async () => {
  const stylesheet = await readFile(new URL("../src/app/app.css", import.meta.url), "utf8");
  expect(stylesheet).toContain("--smart-embed-target-width: calc(100ch + 8rem + 4px)");
  expect(stylesheet).toContain("box-sizing: border-box");
  expect(stylesheet).toContain("width: min(var(--smart-embed-target-width), 100%)");
  expect(stylesheet).toContain("max-width: 100%");
  expect(stylesheet).not.toContain("calc(100% + 16rem)");
  expect(stylesheet).not.toContain("transform: translateX(-50%)");
});

test("registers the smart embed directives", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives.map((directive) => directive.id)).toEqual([
    "smart-diff",
    "smart-patch",
    "smart-code",
    "smart-image-compare",
  ]);
});

test("registers Devin branding for the Devin ACP agent provider", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(
    captured.providerIcons.map(({ providerKind, providerId }) => ({ providerKind, providerId })),
  ).toEqual([{ providerKind: "agent", providerId: "acp-devin" }]);
  const icon = renderSlot({ component: captured.providerIcons[0]!.icon }, { className: "size-4" });
  const svg = icon.container.querySelector("svg");
  expect(svg?.getAttribute("class")).toBe("size-4");
  expect(svg?.getAttribute("viewBox")).toBe("0 0 386 386");
  expect(svg?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  icon.unmount();
});

function readyCode(patchText: string) {
  return {
    status: "ready" as const,
    kind: "code" as const,
    path: "src/example.ts",
    label: "src/example.ts",
    content: patchText,
    startLine: 1,
    truncated: false,
  };
}

async function renderCodeEmbed(
  renderEmbed: () => Promise<import("../src/shared/contract.ts").RenderEmbedOutput>,
) {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-code");
  expect(directive).toBeDefined();
  return renderSlot(
    directive!,
    {
      attributes: { path: "src/example.ts" },
      source: '::smart-code{path="src/example.ts"}',
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

test("renders citations at their source line numbers", async () => {
  embedCache.clear();
  const slot = await renderCodeEmbed(async () => ({
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
  expect(slot.queryByText("Changes")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("serves a remount from the cache without a loading state or a second RPC call", async () => {
  embedCache.clear();
  const first = await renderCodeEmbed(async () => readyCode(patch));
  await first.findByTestId("bb-diff");
  expect(first.rpcCalls.map((call) => call.method)).toEqual(["renderEmbed"]);
  expect(first.rpcCalls[0]?.input).toEqual({
    kind: "code",
    threadId: "thread-1",
    path: "src/example.ts",
  });
  first.unmount();

  const second = await renderCodeEmbed(async () => readyCode(patch));
  expect(second.queryByText("Loading src/example.ts…")).toBeNull();
  expect(second.getByTestId("bb-diff")).toBeDefined();
  expect(second.rpcCalls).toEqual([]);
  second.unmount();
  embedCache.clear();
});

test("refetches in place when the server reports the thread's workspace changed", async () => {
  embedCache.clear();
  let version = 0;
  const slot = await renderCodeEmbed(async () => {
    version += 1;
    return readyCode(`${patch}# v${version}\n`);
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
  const slot = await renderCodeEmbed(async () => readyCode(patch));
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
  const slot = await renderCodeEmbed(async () => ({
    status: "ready",
    kind: "code",
    path: "src/example.ts",
    label: "src/example.ts",
    content: "",
    startLine: 1,
    truncated: false,
  }));
  await slot.findByText("Empty source.");
  expect(slot.queryByTestId("bb-diff")).toBeNull();
  slot.unmount();
  embedCache.clear();
});

test("Unity citations show a single current-value column and allow raw YAML review", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-code")!;
  const slot = renderSlot(
    directive,
    {
      attributes: { path: "Hero.prefab" },
      source: "::smart-code",
      message: {
        id: "message-unity",
        threadId: "thread-unity",
        turnId: "turn-unity",
        projectId: "project-unity",
      },
      openWorkspaceFile: null,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready",
          kind: "code",
          path: "Hero.prefab",
          label: "Hero.prefab",
          content: "speed: 8",
          startLine: 1,
          truncated: false,
          unity: {
            propertyCount: 1,
            groups: [
              {
                id: "1",
                name: "Player",
                hierarchy: "Actors",
                components: [
                  { id: "2", type: "Movement", properties: [{ path: "speed", value: "8" }] },
                ],
              },
            ],
          },
        }),
      },
    },
  );
  await slot.findByText("Player");
  expect(slot.getByRole("columnheader", { name: "Value" })).toBeTruthy();
  expect(slot.queryByRole("columnheader", { name: "Before" })).toBeNull();
  expect(slot.queryByRole("columnheader", { name: "After" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Raw YAML" }));
  expect(slot.getByTestId("bb-diff").textContent).toContain(" speed: 8");
  fireEvent.click(slot.getByRole("button", { name: "Object view" }));
  expect(slot.getByText("Player")).toBeTruthy();
  slot.unmount();
  embedCache.clear();
});

test("smart-diff passes exact message identity and renders through BB Diff", async () => {
  embedCache.clear();
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-diff")!;
  const result = {
    status: "ready",
    kind: "diff",
    path: "a.ts",
    label: "a.ts",
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    source: "Recorded turn: turn-1",
    truncated: false,
  };
  const slot = renderSlot(
    directive,
    {
      attributes: { path: "a.ts" },
      source: '::smart-diff{path="a.ts"}',
      message: { id: "m", threadId: "t", turnId: "turn-1", projectId: null },
      openWorkspaceFile: null,
    },
    { rpc: { renderEmbed: async () => result } },
  );
  expect((await slot.findByTestId("bb-diff")).textContent).toBe(result.patch);
  expect(slot.rpcCalls[0]?.input).toEqual({
    kind: "diff",
    path: "a.ts",
    messageId: "m",
    threadId: "t",
    turnId: "turn-1",
  });
  expect(slot.getByText(result.source)).toBeDefined();
  slot.unmount();
  embedCache.clear();
});
test("smart-patch renders each proposal file through BB Diff", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const directive = captured.messageDirectives.find((item) => item.id === "smart-patch")!;
  const files = [
    { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    { path: "b.ts", patch: "@@ -1 +1 @@\n-c\n+d\n" },
  ];
  const slot = renderSlot(
    directive,
    {
      attributes: { file: "p.patch" },
      source: '::smart-patch{file="p.patch"}',
      message: { id: "m", threadId: "t", turnId: "turn-1", projectId: null },
      openWorkspaceFile: null,
    },
    {
      rpc: {
        renderEmbed: async () => ({
          status: "ready",
          kind: "patch",
          path: "p.patch",
          label: "p.patch",
          patch: "",
          files,
          source: "Proposal: p.patch",
          truncated: false,
        }),
      },
    },
  );
  await waitFor(() => expect(slot.getAllByTestId("bb-diff")).toHaveLength(2));
  expect(slot.getAllByTestId("bb-diff").map((node) => node.dataset.path)).toEqual(["a.ts", "b.ts"]);
  slot.unmount();
  embedCache.clear();
});
