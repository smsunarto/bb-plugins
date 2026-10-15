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
  const executed: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    sdk: { plugins: { list: async () => ({ plugins: [] }) } },
    experimental_callHostRpc: ({ method, input }) => {
      if (method === "discover") return { instances: [instance], warnings: [] };
      if (method === "probe") return { pid: 101 };
      if (method === "quiet") return { quiet: true };
      if (method === "execute") {
        executed.push(input);
        return { jobId: "job-1" };
      }
      if (method === "job")
        return { jobId: "job-1", state: "completed", result: { playMode: "stopped" } };
      throw new Error("Unexpected host method");
    },
  });
  await plugin(bb);
  const claimArgs = ["manage", "claim", "--host", "host", "--instance", "main-1"];
  expect((await harness.runCli(claimArgs)).exitCode).toBe(1);
  const first = await harness.runCli(claimArgs, { threadId: "alice" });
  expect(first.exitCode).toBe(0);
  const claim = JSON.parse(first.stdout!);
  expect(claim.ownerThreadId).toBe("alice");
  const conflict = await harness.runCli(claimArgs, { threadId: "bob" });
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toContain("owned by @thread:alice");
  const command = [
    "manage",
    "command",
    "--host",
    "host",
    "--instance",
    "main-1",
    "--claim",
    claim.claimId,
    "--command",
    "editor_status",
  ];
  expect((await harness.runCli(command, { threadId: "bob" })).exitCode).toBe(1);
  expect((await harness.runCli(command, { threadId: "alice" })).exitCode).toBe(0);
  expect(executed).toEqual([{ instance, command: "editor_status", parameters: {} }]);
  const status = await harness.runCli(
    ["manage", "status", "--host", "host", "--instance", "main-1", "--claim", claim.claimId],
    { threadId: "alice" },
  );
  expect(JSON.parse(status.stdout!).job.result).toEqual({ playMode: "stopped" });
  expect(
    (
      await harness.runCli(
        ["manage", "release", "--host", "host", "--instance", "main-1", "--claim", claim.claimId],
        { threadId: "alice" },
      )
    ).exitCode,
  ).toBe(0);
  expect(harness.registrations.agentTools.map((tool) => tool.name)).toContain("game_studio_manage");
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
