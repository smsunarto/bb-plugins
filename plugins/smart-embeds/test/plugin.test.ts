import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import plugin, { SMART_EMBED_INSTRUCTIONS } from "../server/server.ts";
import { WORKSPACE_CHANGED_CHANNEL } from "../shared/contract.ts";

test("registers the RPC and injects Smart Embed instructions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "smart-embeds" });
  await plugin(bb);

  expect(harness.registrations.rpcMethods).toEqual(["renderEmbed"]);
  const instructions = harness.registrations.instructionProvider?.({
    threadId: "thread-1",
    projectId: "project-1",
  });
  expect(instructions).toBe(SMART_EMBED_INSTRUCTIONS);
  expect(instructions).toContain("::smart-diff");
  expect(instructions).toContain("::smart-code");
});

test("publishes a workspace-changed signal when a thread settles, fails, or goes away", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "smart-embeds" });
  await plugin(bb);
  const thread = makeThreadResponse({ id: "thread-9" });

  await harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
  await harness.emitThreadEvent("thread.failed", { thread, error: "boom" });
  await harness.emitThreadEvent("thread.archived", { thread });
  await harness.emitThreadEvent("thread.deleted", { thread });
  await harness.emitThreadEvent("thread.active", { thread });

  expect(harness.realtimeSignals).toEqual([
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "idle" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "failed" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "archived" } },
    { channel: WORKSPACE_CHANGED_CHANNEL, payload: { threadId: "thread-9", reason: "deleted" } },
  ]);
});
