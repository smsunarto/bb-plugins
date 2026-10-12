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
    pluginId: "kitchen-sink",
    experimental_callHostRpc: ({ method }) => {
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  const tool = harness.registrations.agentTools.find((t) => t.name === "kitchen_sink_editors")!;
  expect(
    tool.parse({ action: "claim", hostId: "host", instanceId: "main-1", ownerThreadId: "forged" })
      .ok,
  ).toBe(false);
  const result = await harness.callAgentTool(
    "kitchen_sink_editors",
    { action: "claim", hostId: "host", instanceId: "main-1" },
    { threadId: "alice" },
  );
  const claim = JSON.parse(result as string);
  expect(claim.ownerThreadId).toBe("alice");
  await expect(
    harness.callAgentTool(
      "kitchen_sink_editors",
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
    pluginId: "kitchen-sink",
    sdk: {
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
    "kitchen_sink_editors",
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
    harness.callAgentTool("kitchen_sink_editors", recovery, { threadId: "bob" }),
  ).rejects.toThrow("still alive");
  archived = true;
  const result = await harness.callAgentTool("kitchen_sink_editors", recovery, { threadId: "bob" });
  expect(JSON.parse(result as string).recovered).toBe(true);
  expect(ownerLookups).toEqual(["alice", "alice", "alice"]);
});
