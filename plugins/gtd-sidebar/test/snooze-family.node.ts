import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ThreadLifecycleRow } from "../lib/lifecycle.ts";
import plugin from "../server.ts";

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
      })) as { ok: boolean; rows: ThreadLifecycleRow[] };
      const { rows } = (await harness.behavior.callRpc("listLifecycle", {})) as {
        rows: ThreadLifecycleRow[];
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
      // Each write refreshes every window's lifecycle read.
      assert.deepEqual(harness.inspection.experimental_rpcInvalidations, [
        ["lifecycle"],
        ["lifecycle"],
      ]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  // The sidebar sends an Undo without waiting for its snooze. The snooze's
  // family read can be the slower one, and the wake must still land last.
  it("applies a snooze and its Undo in the order they arrive", async () => {
    let releaseSnoozeRead!: () => void;
    const snoozeRead = new Promise<void>((resolve) => {
      releaseSnoozeRead = resolve;
    });
    let reads = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: {
          list: async () => {
            if (++reads === 1) await snoozeRead;
            return [];
          },
        },
      },
    });
    await plugin(bb);
    try {
      const snooze = harness.behavior.callRpc("snooze", {
        threadId: "root",
        snoozedUntil: Date.now() + 86_400_000,
      });
      const wake = harness.behavior.callRpc("unsnooze", { threadId: "root" });
      releaseSnoozeRead();
      await Promise.all([snooze, wake]);
      assert.deepEqual(await harness.behavior.callRpc("listLifecycle", {}), { rows: [] });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  // Migrations are append-only, so the columns stay nullable. A row an older
  // build left with one snooze time is dropped at the read rather than handed
  // to the sidebar as a snooze that can never wake on activity.
  it("omits a stored row that is missing either snooze time", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: { subscribe: () => () => {}, threads: { list: async () => [] } },
    });
    await plugin(bb);
    try {
      const insert = bb.storage
        .database()
        .prepare(
          `INSERT INTO thread_lifecycle (thread_id, snoozed_until, snoozed_at) VALUES (?, ?, ?)`,
        );
      insert.run("no-start", Date.now() + 86_400_000, null);
      insert.run("no-wake", null, Date.now());
      assert.deepEqual(await harness.behavior.callRpc("listLifecycle", {}), { rows: [] });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
