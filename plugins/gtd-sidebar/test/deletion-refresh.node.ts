import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { SETTLED_WINDOW_MS, type SettledThreadRow } from "../lib/settled-threads.ts";

describe("deletion refresh routing", () => {
  for (const { label, archivedAt, snoozed, kinds } of [
    { label: "unarchived", archivedAt: null, snoozed: false, kinds: [] },
    { label: "old archive", archivedAt: 1, snoozed: false, kinds: [] },
    { label: "snoozed", archivedAt: null, snoozed: true, kinds: ["lifecycle"] },
    { label: "recent archive", archivedAt: Date.now(), snoozed: false, kinds: ["archive"] },
    {
      label: "recent archive with a snooze row",
      archivedAt: Date.now(),
      snoozed: true,
      kinds: ["lifecycle", "archive"],
    },
  ]) {
    it(`refreshes only changed shelves when deleting ${label}`, async () => {
      const thread = makeThreadResponse({ id: "removed", archivedAt });
      const { bb, harness } = createFakePluginHost({
        pluginId: "gtd-sidebar",
        sdk: { subscribe: () => () => {}, threads: { list: async () => [] } },
      });
      await plugin(bb);
      try {
        if (snoozed) {
          await harness.behavior.callRpc("snooze", {
            threadId: thread.id,
            snoozedUntil: Date.now() + SETTLED_WINDOW_MS,
          });
        }
        const before = harness.inspection.realtimeSignals.length;
        await harness.behavior.emitThreadEvent("thread.deleted", { thread });
        assert.deepEqual(
          harness.inspection.realtimeSignals.slice(before).map(({ channel, payload }) => ({
            channel,
            payload,
          })),
          kinds.map((kind) => ({ channel: "lifecycle", payload: { kind, threadId: "removed" } })),
        );
        assert.deepEqual(await harness.behavior.callRpc("listLifecycle", {}), { rows: [] });
      } finally {
        await harness.lifecycle.dispose();
      }
    });
  }

  it("keeps the recent shelf intact during unrelated cleanup and refreshes its own deletion", async () => {
    const recent = {
      ...makeThreadResponse({ id: "recent", title: "Keep visible", archivedAt: Date.now() }),
      hasPendingInteraction: false,
      activity: {
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 0,
        activeGoalCount: 0,
      },
    };
    const old = Array.from({ length: 1_000 }, (_, index) =>
      makeThreadResponse({ id: `old-${index}`, archivedAt: 1 }),
    );
    let threads = [recent, ...old];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: {
          list: async (args) =>
            threads.slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.limit ?? 200)),
        },
      },
    });
    await plugin(bb);
    const settledIds = async () => {
      const result = (await harness.behavior.callRpc("listSettledThreads", {})) as {
        threads: SettledThreadRow[];
      };
      return result.threads.map(({ id, title }) => ({ id, title }));
    };
    try {
      assert.deepEqual(await settledIds(), [{ id: "recent", title: "Keep visible" }]);
      for (const thread of old) {
        await harness.behavior.emitThreadEvent("thread.deleted", { thread });
      }
      assert.deepEqual(harness.inspection.realtimeSignals, []);
      threads = [recent];
      assert.deepEqual(await settledIds(), [{ id: "recent", title: "Keep visible" }]);
      threads = [];
      await harness.behavior.emitThreadEvent("thread.deleted", { thread: recent });
      assert.deepEqual(
        harness.inspection.realtimeSignals.map(({ channel, payload }) => ({ channel, payload })),
        [{ channel: "lifecycle", payload: { kind: "archive", threadId: "recent" } }],
      );
      assert.deepEqual(await settledIds(), []);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
