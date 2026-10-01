import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

// A path that cannot exist keeps load deterministic: the repo is missing,
// so setup records needsConfiguration and nothing spawns a shell.
async function load() {
  const host = createFakePluginHost({
    pluginId: "dotfiles",
    settings: { repoPath: "/nonexistent/dotfiles" },
  });
  await plugin(host.bb);
  return host.harness;
}

test("the plugin registers its RPC and CLI against the fake host", async () => {
  const harness = await load();

  assert.deepEqual([...harness.registrations.rpcMethods].sort(), [
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

test("a command against a missing repo exits 1 with the repo path on stderr", async () => {
  const harness = await load();
  assert.deepEqual(await harness.runCli(["status"]), {
    exitCode: 1,
    stdout: "",
    stderr: "dotfiles repo not found at /nonexistent/dotfiles\n",
  });
});

test("the SDK parser rejects bad argv with exit 1 and the usage line", async () => {
  const harness = await load();
  assert.deepEqual(await harness.runCli(["cat"]), {
    exitCode: 1,
    stdout: "",
    stderr: "missing required arguments: <path>\n\nUsage:\n  bb dotfiles cat <path>\n",
  });
  assert.deepEqual(await harness.runCli(["sync", "--push"]), {
    exitCode: 1,
    stdout: "",
    stderr: "unknown option '--push'\n\nUsage:\n  bb dotfiles sync [--publish]\n",
  });
  assert.deepEqual(await harness.runCli(["check", "mise", "shell"]), {
    exitCode: 1,
    stdout: "",
    stderr: "unexpected argument 'shell'\n\nUsage:\n  bb dotfiles check [<target>]\n",
  });
});

test("help renders the declared positionals and flags", async () => {
  const harness = await load();
  assert.deepEqual(await harness.runCli(["cat", "--help"]), {
    exitCode: 0,
    stdout:
      "bb dotfiles cat — Print a tweakable file\n\n" +
      "Usage:\n  bb dotfiles cat <path>\n\n" +
      "Arguments:\n  <path>  repo-relative path (required)\n",
    stderr: "",
  });
  assert.deepEqual(await harness.runCli(["sync", "--help"]), {
    exitCode: 0,
    stdout:
      "bb dotfiles sync — Sync the repo; default is consume-only, --publish pushes\n\n" +
      "Usage:\n  bb dotfiles sync [--publish]\n\n" +
      "Options:\n" +
      "  --publish   publish: rebase, push, re-apply, and render\n" +
      "  --help, -h  Show this help and exit\n",
    stderr: "",
  });
});
