import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { type StoredLifecycleRow } from "../server.ts";

describe("family snooze RPC", () => {
  it("stores one wake time for a parent and its descendants, then wakes them together", async () => {
    const threads = [
      makeThreadResponse({ id: "root", parentThreadId: null }),
      makeThreadResponse({ id: "child", parentThreadId: "root" }),
      makeThreadResponse({ id: "grandchild", parentThreadId: "child" }),
      makeThreadResponse({ id: "fork", parentThreadId: "root", originKind: "fork" }),
    ];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: {
          list: async (args) =>
            threads
              .filter((thread) => thread.parentThreadId === args?.parentThreadId)
              .slice(args?.offset ?? 0, (args?.offset ?? 0) + (args?.limit ?? 200)),
        },
      },
    });
    await plugin(bb);
    try {
      const wakeAt = Date.now() + 86_400_000;
      const written = (await harness.behavior.callRpc("snooze", {
        threadId: "root",
        snoozedUntil: wakeAt,
      })) as { ok: boolean; rows: StoredLifecycleRow[] };
      const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as {
        rows: StoredLifecycleRow[];
      };
      // The write answers with the same rows a re-read would.
      assert.deepEqual(written, { ok: true, rows });
      assert.deepEqual(rows.map((row) => row.threadId).sort(), ["child", "grandchild", "root"]);
      assert.ok(rows.every((row) => row.snoozedUntil === wakeAt));
      assert.equal(new Set(rows.map((row) => row.snoozedAt)).size, 1);
      assert.deepEqual(await harness.behavior.callRpc("unsnooze", { threadId: "root" }), {
        ok: true,
        rows: [],
      });
      assert.deepEqual(await harness.behavior.callRpc("listLifecycle", {}), { rows: [] });
      assert.equal(harness.inspection.sdk.callsTo("threads.update").length, 0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
