import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("a turn that ends, idle or failed, tells the panels on its environment", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "gitbutler" });
  await plugin(bb);

  const child = makeThreadResponse({
    id: "thr_child",
    environmentId: "env-1",
    parentThreadId: "thr_1",
  });
  await harness.behavior.emitThreadEvent("thread.idle", { thread: child, lastAssistantText: null });
  await harness.behavior.emitThreadEvent("thread.failed", { thread: child, error: null });
  // A thread with no environment changed no workspace.
  const bare = makeThreadResponse({ id: "thr_bare", environmentId: null });
  await harness.behavior.emitThreadEvent("thread.idle", { thread: bare, lastAssistantText: null });

  const signal = {
    channel: "workspace-changed",
    payload: { environmentId: "env-1", threadId: "thr_child", parentThreadId: "thr_1" },
  };
  expect(harness.inspection.realtimeSignals).toEqual([signal, signal]);
  await harness.lifecycle.dispose();
});
