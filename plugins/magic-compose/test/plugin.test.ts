import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";

it("loads the fork and preserves preferences across reloads", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "magic-compose" });
  try {
    await plugin(bb);
    const initial = await harness.behavior.callRpc("preferencesGet", null);
    expect(initial).toMatchObject({ preferences: { holdSend: true, pace: "typing" } });
    await harness.behavior.callRpc("preferencesSet", { preferences: { holdSend: false } });
    const saved = await harness.behavior.runCli(["preferences", "get", "--json"]);
    expect(saved.exitCode).toBe(0);
    expect(JSON.parse(saved.stdout ?? "")).toMatchObject({ holdSend: false });
    ({ harness } = await harness.lifecycle.reload(plugin));
    expect(await harness.behavior.callRpc("preferencesGet", null)).toMatchObject({
      preferences: { holdSend: false },
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps upstream RPC names, including the tuning skill scope update", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "magic-compose" });
  try {
    await plugin(bb);
    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "preferences_get",
        "preferences_set",
        "rotation_get",
        "rotation_set",
        "scope_get",
        "scope_set",
        "rotation_seed",
      ]),
    );
    await harness.behavior.callRpc("preferences_set", { preferences: { holdSend: false } });
    expect(await harness.behavior.callRpc("preferences_get", null)).toMatchObject({
      preferences: { holdSend: false },
    });
    const scope = { reasoningLevels: ["low", "medium", "high", "xhigh"] };
    expect(await harness.behavior.callRpc("scope_set", { scope })).toMatchObject({ scope });
    await harness.behavior.callRpc("rotation_set", { entries: [] });
    expect(await harness.behavior.callRpc("rotation_get", null)).toEqual({ entries: [] });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("documents compound command usage and rejects unrelated options", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "magic-compose" });
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(["preferences", "--help"]);
    expect(help.stdout).toContain("preferences set <key> <value>");
    const invalid = await harness.behavior.runCli(["machines", "--map", "x"]);
    expect(invalid.exitCode).not.toBe(0);
    const missing = await harness.behavior.runCli(["route"]);
    expect(missing.exitCode).not.toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
