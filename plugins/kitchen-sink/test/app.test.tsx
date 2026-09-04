import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { readFile } from "node:fs/promises";

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

test("registers the smart diff and code message directives", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  expect(captured.messageDirectives.map((directive) => directive.id)).toEqual([
    "smart-diff",
    "smart-code",
  ]);
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

async function renderDiffEmbed(renderEmbed: () => Promise<ReturnType<typeof readyDiff>>) {
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

test("serves a remount from the cache without a loading state or a second RPC call", async () => {
  embedCache.clear();
  const first = await renderDiffEmbed(async () => readyDiff(patch));
  await first.findByTestId("bb-diff");
  expect(first.rpcCalls.map((call) => call.method)).toEqual(["renderEmbed"]);
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
