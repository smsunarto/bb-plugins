import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

test("the plugin registers its RPC and CLI against the fake host", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dotfiles",
    // A path that cannot exist keeps setup deterministic: the repo is
    // missing, so load records needsConfiguration and touches no repo.
    settings: { repoPath: "/nonexistent/dotfiles" },
  });
  await plugin(bb);

  assert.deepEqual([...harness.registrations.rpcMethods].sort(), [
    "monacoAssets",
    "overview",
    "publish",
    "readFile",
    "removeSkill",
    "runTask",
    "saveFile",
  ]);

  const cli = harness.registrations.cli;
  assert.ok(cli, "server.ts registers the CLI");
  assert.equal(cli.name, "dotfiles");
  assert.deepEqual(cli.commands.map((command) => command.name).sort(), [
    "cat",
    "check",
    "list",
    "render",
    "rpc",
    "status",
    "sync",
  ]);

  assert.deepEqual(harness.needsConfigurationMessages, [
    "Dotfiles repo not found at /nonexistent/dotfiles. " +
      "Configure repoPath in the Dotfiles plugin settings.",
  ]);
});
