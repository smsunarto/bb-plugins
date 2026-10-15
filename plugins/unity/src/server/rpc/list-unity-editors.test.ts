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
    pluginId: "unity",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: ({ method }) => {
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  await harness.behavior.callAgentTool(
    "unity_manage",
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
