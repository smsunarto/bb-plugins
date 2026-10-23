import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("Editor CLI binds ownership to the calling thread and blocks another caller", async () => {
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
  const methods: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: ({ method }) => {
      methods.push(method);
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      if (method === "quiet") return { quiet: true };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  const claimArgs = ["manage", "claim", "--host", "host", "--instance", "main-1"];
  expect((await harness.runCli(claimArgs)).exitCode).toBe(1);
  const first = await harness.runCli(claimArgs, { threadId: "alice" });
  expect(first.exitCode).toBe(0);
  const { background, ...claim } = JSON.parse(first.stdout!);
  expect([claim.ownerThreadId, background]).toEqual(["alice", { quiet: true }]);
  const conflict = await harness.runCli(claimArgs, { threadId: "bob" });
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toContain("owned by @thread:alice");
  const forbiddenRelease = await harness.runCli(
    ["manage", "release", "--host", "host", "--instance", "main-1", "--claim", claim.claimId],
    { threadId: "bob" },
  );
  expect(forbiddenRelease.exitCode).toBe(1);
  expect(forbiddenRelease.stderr).toContain("owned by this BB thread");
  const status = await harness.runCli(
    ["manage", "status", "--host", "host", "--instance", "main-1", "--claim", claim.claimId],
    { threadId: "alice" },
  );
  expect(JSON.parse(status.stdout!)).toEqual({ claim, job: null, background: { quiet: true } });
  expect(
    (
      await harness.runCli(
        ["manage", "release", "--host", "host", "--instance", "main-1", "--claim", claim.claimId],
        { threadId: "alice" },
      )
    ).exitCode,
  ).toBe(0);
  // A new claim reports the Editor's idle state, so it probes quiet once more than before.
  expect(methods).toEqual(["discover", "probe", "quiet", "discover", "quiet", "quiet"]);
  expect(harness.registrations.agentTools.map((tool) => tool.name)).toContain("game_studio_manage");
});

test("the management CLI rejects command execution and removed flags before contacting a host", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: () => {
      throw new Error("Command execution must be rejected before host lookup");
    },
  });
  await plugin(bb);
  for (const args of [
    ["manage", "command", "--instance", "main", "--claim", "claim"],
    ["manage", "command", "--command", "run_script", "--parameters", "{}"],
    ["manage", "claim", "--instance", "main", "--command", "run_script"],
    ["manage", "status", "--instance", "main", "--claim", "claim", "--parameters", "{}"],
  ]) {
    const result = await harness.behavior.runCli(args, { threadId: "alice" });
    expect(result.exitCode).toBe(1);
  }
  expect(harness.experimental_hostRpcCalls).toEqual([]);
  await harness.lifecycle.dispose();
});

test("Game Studio exposes both workflows and the consolidated Unity tools to agents", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    agentSkillIds: ["game-studio", "unity-editors"],
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
  });
  await plugin(bb);
  const configuration = await harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext(),
  );
  expect(configuration.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["game_studio_manage", "game_studio_slots"]),
  );
  expect(configuration.skills).toEqual(["game-studio", "unity-editors"]);
  await harness.lifecycle.dispose();
});
