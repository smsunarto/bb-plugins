import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("the agent tool refuses caller-forged owners and requires confirmation for reconciliation", async () => {
  const instance = {
    id: "main-1",
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
  const tool = harness.registrations.agentTools.find((t) => t.name === "unity_manage")!;
  expect(
    tool.parse({ action: "claim", hostId: "host", instanceId: "main-1", ownerThreadId: "forged" })
      .ok,
  ).toBe(false);
  const result = await harness.callAgentTool(
    "unity_manage",
    { action: "claim", hostId: "host", instanceId: "main-1" },
    { threadId: "alice" },
  );
  const claim = JSON.parse(result as string);
  expect(claim.ownerThreadId).toBe("alice");
  await expect(
    harness.callAgentTool(
      "unity_manage",
      { action: "reconcile", hostId: "host", instanceId: "main-1", claimId: claim.claimId },
      { threadId: "alice" },
    ),
  ).rejects.toThrow("explicit confirmation");
});

test("orphan recovery consults BB's current owner record even when lifecycle events were missed", async () => {
  const instance = {
    id: "main-1",
    projectPath: "/game",
    workspacePath: "/game",
    pid: 101,
    port: 7800,
    version: "6000.3.10f1",
    startedAt: "birth",
    clone: false,
  };
  let archived = false;
  const ownerLookups: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "unity",
    sdk: {
      plugins: { list: async () => ({ plugins: [] }) },
      threads: {
        get: async ({ threadId }) => {
          ownerLookups.push(threadId);
          return makeThreadResponse({ id: threadId, archivedAt: archived ? 1 : null });
        },
      },
    },
    experimental_callHostRpc: ({ method }) => {
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      if (method === "alive") return { alive: true };
      if (method === "quiet") return { quiet: true };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  await harness.callAgentTool(
    "unity_manage",
    { action: "claim", hostId: "host", instanceId: "main-1" },
    { threadId: "alice" },
  );
  const recovery = {
    action: "recover",
    hostId: "host",
    instanceId: "main-1",
    confirmNoPendingWork: true,
    note: "Owned input and recorder stopped; no background work remains",
  };
  await expect(
    harness.callAgentTool("unity_manage", recovery, { threadId: "bob" }),
  ).rejects.toThrow("still alive");
  archived = true;
  const result = await harness.callAgentTool("unity_manage", recovery, { threadId: "bob" });
  expect(JSON.parse(result as string).recovered).toBe(true);
  expect(ownerLookups).toEqual(["alice", "alice", "alice"]);
});

test("an unavailable legacy handoff blocks claims and commands before contacting Unity", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "unity",
    sdk: {
      plugins: {
        list: async () => ({
          plugins: [{ id: "kitchen-sink", enabled: true, status: "running" }] as never,
        }),
        callRpc: async () => {
          throw new Error("The updated Kitchen Sink export is unavailable");
        },
      },
    },
    experimental_callHostRpc: () => {
      throw new Error("The migration gate must run before contacting Unity");
    },
  });
  await plugin(bb);
  for (const input of [
    { action: "claim", hostId: "host", instanceId: "main" },
    {
      action: "command",
      hostId: "host",
      instanceId: "main",
      claimId: "stale-token",
      command: "run_script",
    },
  ]) {
    await expect(
      harness.behavior.callAgentTool("unity_manage", input, { threadId: "alice" }),
    ).rejects.toThrow("Unity claim migration is incomplete");
  }
  expect(harness.experimental_hostRpcCalls).toEqual([]);
  await harness.lifecycle.dispose();
});
