import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

async function withPlugin(
  run: (harness: ReturnType<typeof createFakePluginHost>["harness"]) => Promise<void>,
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: { subscribe: () => () => {}, threads: { list: async () => [] } },
  });
  await plugin(bb);
  try {
    await run(harness);
  } finally {
    await harness.lifecycle.dispose();
  }
}

const collapsed = (harness: Parameters<Parameters<typeof withPlugin>[0]>[0], familyIds: string[]) =>
  harness.behavior.callRpc("listCollapsedThreads", { familyIds });

const fold = (
  harness: Parameters<Parameters<typeof withPlugin>[0]>[0],
  threadId: string,
  isCollapsed: boolean,
) => harness.behavior.callRpc("setThreadCollapsed", { threadId, collapsed: isCollapsed });

describe("family folds", () => {
  it("folds every family until it is opened, and refreshes fold reads on each change", async () => {
    await withPlugin(async (harness) => {
      assert.deepEqual(await collapsed(harness, ["a", "b"]), { threadIds: ["a", "b"] });
      const before = harness.inspection.experimental_rpcInvalidations.length;
      assert.deepEqual(await fold(harness, "a", false), { expandedThreadIds: ["a"] });
      assert.deepEqual(harness.inspection.experimental_rpcInvalidations.slice(before), [
        ["collapsed"],
      ]);
      assert.deepEqual(await collapsed(harness, ["a", "b"]), { threadIds: ["b"] });
      assert.deepEqual(await fold(harness, "a", true), { expandedThreadIds: [] });
      assert.deepEqual(await collapsed(harness, ["a", "b"]), { threadIds: ["a", "b"] });
    });
  });

  it("keeps both of two overlapping toggles from different windows", async () => {
    await withPlugin(async (harness) => {
      await Promise.all([fold(harness, "a", false), fold(harness, "b", false)]);
      assert.deepEqual(await collapsed(harness, ["a", "b"]), { threadIds: [] });
    });
  });

  it("refreshes fold reads when the preference is set from the CLI", async () => {
    await withPlugin(async (harness) => {
      const before = harness.inspection.experimental_rpcInvalidations.length;
      const result = await harness.behavior.runCli(["prefs", "set", "expandedThreads", '["c"]']);
      assert.equal(result.exitCode ?? 0, 0);
      assert.deepEqual(harness.inspection.experimental_rpcInvalidations.slice(before), [
        ["collapsed"],
      ]);
      assert.deepEqual(await collapsed(harness, ["c", "d"]), { threadIds: ["d"] });
    });
  });

  it("forgets an opened family once its parent is deleted", async () => {
    await withPlugin(async (harness) => {
      await fold(harness, "a", false);
      await fold(harness, "b", false);
      await harness.behavior.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: "a" }),
      });
      assert.deepEqual(await fold(harness, "b", false), { expandedThreadIds: ["b"] });
    });
  });
});
