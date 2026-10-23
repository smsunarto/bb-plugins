import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("the public inventory RPC exposes slots but never owner capabilities from a caller-supplied thread", async () => {
  const instance = {
    id: "main",
    projectPath: "/game",
    workspacePath: "/game",
    pid: 101,
    port: 7800,
    version: "6000.3.10f1",
    startedAt: "birth",
    clone: false,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: ({ method }) => {
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      if (method === "quiet") return { quiet: true };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  await harness.behavior.callAgentTool(
    "game_studio_manage",
    { action: "claim", hostId: "host", instanceId: "main", mode: "authoring" },
    { threadId: "alice" },
  );
  const inventory = (await harness.behavior.callRpc("listUnityEditors", {
    hostId: "host",
    threadId: "alice",
  })) as {
    claims: Array<{ ownerThreadId: string }>;
    slots: Array<{ workspacePath: string; claims: unknown[] }>;
  };
  expect(inventory.claims[0]?.ownerThreadId).toBe("alice");
  expect(inventory.claims[0]).not.toHaveProperty("claimId");
  expect(inventory.slots[0]?.workspacePath).toBe("/game");
  expect(inventory.slots[0]?.claims[0]).not.toHaveProperty("claimId");
  await harness.lifecycle.dispose();
});

test("inventory reads within a few seconds share one host discovery", async () => {
  let discoveries = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: ({ method }) => {
      if (method !== "discover") throw new Error("Unexpected host method");
      discoveries += 1;
      return { instances: [], warnings: [] };
    },
  });
  await plugin(bb);
  const [first, second] = await Promise.all([
    harness.behavior.callRpc("listUnityEditors", { hostId: "host" }),
    harness.behavior.callRpc("listUnityEditors", { hostId: "host" }),
  ]);
  await harness.behavior.callRpc("listUnityEditors", { hostId: "host" });
  expect(first).toEqual(second);
  expect(discoveries).toBe(1);
  // Another machine has its own discovery.
  await harness.behavior.callRpc("listUnityEditors", { hostId: "other-host" });
  expect(discoveries).toBe(2);
  await harness.lifecycle.dispose();
});
