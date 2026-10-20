import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const machineIds = ["studio", "server", "laptop"];

test("machine commands merge across windows, guard the last machine, persist, and publish once", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: { subscribe: () => () => {} },
  });
  await plugin(bb);
  try {
    const signals = () =>
      harness.inspection.realtimeSignals.filter(
        (signal) =>
          signal.channel === "lifecycle" &&
          typeof signal.payload === "object" &&
          signal.payload !== null &&
          "kind" in signal.payload &&
          signal.payload.kind === "machines",
      ).length;
    assert.deepEqual(await harness.behavior.callRpc("listMachineVisibility", {}), {
      hiddenMachineIds: [],
    });
    await Promise.all(
      ["studio", "server"].map((machineId) =>
        harness.behavior.callRpc("changeMachineVisibility", {
          kind: "set",
          machineId,
          visible: false,
          machineIds,
        }),
      ),
    );
    assert.deepEqual(await harness.behavior.callRpc("listMachineVisibility", {}), {
      hiddenMachineIds: ["server", "studio"],
    });
    assert.equal(signals(), 2);
    for (const machineId of ["server", "laptop"]) {
      await harness.behavior.callRpc("changeMachineVisibility", {
        kind: "set",
        machineId,
        visible: false,
        machineIds,
      });
    }
    assert.equal(signals(), 2);
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    assert.deepEqual(await harness.behavior.callRpc("listMachineVisibility", {}), {
      hiddenMachineIds: ["server", "studio"],
    });
    assert.deepEqual(
      await harness.behavior.callRpc("changeMachineVisibility", {
        kind: "only",
        machineId: "studio",
        machineIds,
      }),
      { hiddenMachineIds: ["laptop", "server"] },
    );
    assert.deepEqual(await harness.behavior.callRpc("changeMachineVisibility", { kind: "all" }), {
      hiddenMachineIds: [],
    });
    const before = signals();
    await harness.behavior.callRpc("changeMachineVisibility", { kind: "all" });
    assert.equal(signals(), before);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a failed machine save does not poison subsequent changes", async () => {
  const { createMachineVisibilityStore } = await import("../lib/machine-visibility-store.ts");
  const { bb, harness } = createFakePluginHost({ pluginId: "gtd-sidebar" });
  let fail = true;
  const store = createMachineVisibilityStore(
    {
      ...bb.storage.kv,
      set: async (key, value) => {
        if (fail) {
          fail = false;
          throw new Error("disk unavailable");
        }
        await bb.storage.kv.set(key, value);
      },
    },
    () => {},
  );
  const command = { kind: "set", machineId: "studio", visible: false, machineIds } as const;
  try {
    await assert.rejects(
      store.change({ ...command, machineIds: [...machineIds] }),
      /disk unavailable/,
    );
    assert.deepEqual(await store.read(), []);
    await store.change({ ...command, machineIds: [...machineIds] });
    assert.deepEqual(await store.read(), ["studio"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a toggle after every listed machine was hidden starts from the menu showing them all", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: { subscribe: () => () => {} },
  });
  // "Only Laptop", then Laptop left bb: the menu shows Studio and Server checked.
  await bb.storage.kv.set("hiddenMachineIds", ["retired", "server", "studio"]);
  await plugin(bb);
  try {
    assert.deepEqual(
      await harness.behavior.callRpc("changeMachineVisibility", {
        kind: "set",
        machineId: "server",
        visible: false,
        machineIds: ["server", "studio"],
      }),
      { hiddenMachineIds: ["retired", "server"] },
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a saved value it cannot read hides nothing and can be replaced", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: { subscribe: () => () => {} },
  });
  await bb.storage.kv.set("hiddenMachineIds", { hostIds: "server" });
  await plugin(bb);
  try {
    assert.deepEqual(await harness.behavior.callRpc("listMachineVisibility", {}), {
      hiddenMachineIds: [],
    });
    await harness.behavior.callRpc("changeMachineVisibility", {
      kind: "only",
      machineId: "studio",
      machineIds,
    });
    assert.deepEqual(await harness.behavior.callRpc("listMachineVisibility", {}), {
      hiddenMachineIds: ["laptop", "server"],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});
