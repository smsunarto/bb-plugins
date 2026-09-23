import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { SETTLED_WINDOW_MS } from "../lib/settled-threads.ts";

describe("deletion refresh routing", () => {
  for (const { label, archivedAt, snoozed, kinds } of [
    { label: "unarchived", archivedAt: null, snoozed: false, kinds: [] },
    { label: "old archive", archivedAt: 1, snoozed: false, kinds: [] },
    { label: "snoozed", archivedAt: null, snoozed: true, kinds: ["lifecycle"] },
    // The Settled shelf is the host's own archive view now; a deletion there
    // reaches every window through bb's thread feed, not this channel.
    { label: "recent archive", archivedAt: Date.now(), snoozed: false, kinds: [] },
    {
      label: "recent archive with a snooze row",
      archivedAt: Date.now(),
      snoozed: true,
      kinds: ["lifecycle"],
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
});
