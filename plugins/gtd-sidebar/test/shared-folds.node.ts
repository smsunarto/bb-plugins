import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

/** Lets the reconcile's awaited thread-list read finish. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("shared folds", () => {
  afterEach(() => mock.timers.reset());

  it("defaults new families to folded and preserves explicit expansion across reloads", async () => {
    let stored = ["existing"];
    let overwrites = 0;
    let { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: { list: async () => [] },
        plugins: {
          callRpc: async ({ method, input, outputSchema }) => {
            if (method === "setPreference") {
              stored = (input as { value: string[] }).value;
              if (overwrites > 0) {
                overwrites -= 1;
                stored = ["existing", "concurrent"];
              }
              return outputSchema.parse(input);
            }
            return outputSchema.parse({ preferences: { collapsedThreads: stored } });
          },
        },
      },
    });
    await plugin(bb);
    try {
      const list = (familyIds: string[]) =>
        harness.behavior.callRpc("listCollapsedThreads", { familyIds });
      assert.deepEqual(await list(["parent", "child"]), {
        threadIds: ["existing", "parent", "child"],
      });
      await harness.behavior.callRpc("setThreadCollapsed", {
        threadId: "parent",
        collapsed: false,
      });
      ({ bb, harness } = await harness.lifecycle.reload(plugin));
      assert.deepEqual(await list(["parent", "child", "new-parent"]), {
        threadIds: ["existing", "child", "new-parent"],
      });
      // A click before initialization still counts as the user's choice.
      await harness.behavior.callRpc("setThreadCollapsed", {
        threadId: "clicked-first",
        collapsed: false,
      });
      assert.deepEqual(await list(["clicked-first"]), {
        threadIds: ["existing", "child", "new-parent"],
      });
      // A built-in sidebar write overwrites the first initialization write.
      overwrites = 1;
      assert.deepEqual(await list(["raced"]), {
        threadIds: ["existing", "concurrent", "raced"],
      });
      // Exhausting reconciliation must leave initialization retryable.
      overwrites = 2;
      await assert.rejects(list(["retry"]), /overwrote the default folds/);
      assert.deepEqual(await list(["retry"]), {
        threadIds: ["existing", "concurrent", "retry"],
      });
      await harness.behavior.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: "retry" }),
      });
      assert.deepEqual(stored, ["existing", "concurrent"]);
      assert.ok(!(await bb.storage.kv.get<string[]>("initializedThreadFolds"))?.includes("retry"));
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("relays a fold made in bb's own sidebar and writes only the fold a window asks for", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let stored: string[] = [];
    const writes: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: { list: async () => [] },
        plugins: {
          callRpc: async ({ pluginId, method, input, outputSchema }) => {
            assert.equal(pluginId, "thread-list");
            if (method === "setPreference") {
              writes.push(input);
              stored = (input as { value: string[] }).value;
              return outputSchema.parse(input);
            }
            return outputSchema.parse({ preferences: { collapsedThreads: stored } });
          },
        },
      },
    });
    await plugin(bb);
    try {
      await flush();
      const collapsedSignals = () =>
        harness.inspection.experimental_rpcInvalidations.filter((tags) =>
          tags?.includes("collapsed"),
        ).length;
      assert.equal(collapsedSignals(), 0);

      stored = ["theirs"];
      mock.timers.tick(2000);
      await flush();
      assert.equal(collapsedSignals(), 1);

      // Already folded there: the window's fold changes nothing.
      assert.deepEqual(
        await harness.behavior.callRpc("setThreadCollapsed", {
          threadId: "theirs",
          collapsed: true,
        }),
        { threadIds: ["theirs"] },
      );
      assert.deepEqual(
        await harness.behavior.callRpc("setThreadCollapsed", { threadId: "mine", collapsed: true }),
        { threadIds: ["theirs", "mine"] },
      );
      assert.deepEqual(writes, [{ key: "collapsedThreads", value: ["theirs", "mine"] }]);

      // The window's own write already invalidated; the next pass stays quiet.
      const afterWrites = collapsedSignals();
      mock.timers.tick(2000);
      await flush();
      assert.equal(collapsedSignals(), afterWrites);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("checks less often while thread-list fails and logs only the outage and the recovery", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let available = false;
    let reads = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: { list: async () => [] },
        plugins: {
          callRpc: async ({ method, outputSchema }) => {
            assert.equal(method, "listPreferences");
            reads += 1;
            if (!available) throw new Error("plugin thread-list is not enabled");
            return outputSchema.parse({ preferences: { collapsedThreads: [] } });
          },
        },
      },
    });
    await plugin(bb);
    try {
      await flush();
      assert.equal(reads, 1);
      for (const delay of [4000, 8000, 16000, 30000, 30000]) {
        mock.timers.tick(delay - 1);
        await flush();
        const before: number = reads;
        mock.timers.tick(1);
        await flush();
        assert.equal(reads, before + 1, `next check after ${delay} ms`);
      }
      const logs = () =>
        harness.inspection.logEntries
          .filter(({ message }) => message.includes("thread-list"))
          .map(({ level, message }) => [level, message]);
      assert.deepEqual(logs(), [
        [
          "warn",
          "cannot read thread-list folds, checking less often until it answers: plugin thread-list is not enabled",
        ],
      ]);

      available = true;
      mock.timers.tick(30000);
      await flush();
      assert.deepEqual(logs().at(-1), ["info", "thread-list folds are readable again"]);
      const recovered = reads;
      mock.timers.tick(2000);
      await flush();
      assert.equal(reads, recovered + 1);
      assert.equal(logs().length, 2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("gives up on a hung thread-list call and stops checking on unload", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const signals: AbortSignal[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "gtd-sidebar",
      sdk: {
        subscribe: () => () => {},
        threads: { list: async () => [] },
        plugins: {
          // Never answers, and ignores its signal.
          callRpc: ({ signal }) => {
            if (signal) signals.push(signal);
            return new Promise(() => {});
          },
        },
      },
    });
    await plugin(bb);
    await flush();
    assert.equal(signals.length, 1);
    mock.timers.tick(5000);
    await flush();
    assert.equal(signals[0]!.aborted, true);
    // The hung check still schedules the next one, backed off.
    mock.timers.tick(4000);
    await flush();
    assert.equal(signals.length, 2);
    await harness.lifecycle.dispose();
    assert.equal(signals[1]!.aborted, true);
    mock.timers.tick(60_000);
    await flush();
    assert.equal(signals.length, 2);
  });
});
