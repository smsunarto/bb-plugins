import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const machines = {
  host_server: makeHostResponse({ id: "host_server", name: "linux-builder", status: "connected" }),
  host_mac: makeHostResponse({ id: "host_mac", name: "Local Mac", status: "connected" }),
};

const checkouts: Record<string, string> = {
  host_server: "/home/codex/git/dotfiles",
  host_mac: "/Users/example/git/dotfiles",
};

/**
 * The plugin over a fake bb whose host entry answers from `checkouts`. A
 * machine in `missing` has no repo at the configured path.
 */
async function load(missing: readonly string[] = []) {
  const host = createFakePluginHost({
    pluginId: "dotfiles",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_server" }) },
      hosts: {
        get: async ({ hostId }: { hostId: string }) => ({
          ...machines[hostId as keyof typeof machines],
          connectMachineId: null,
        }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          environment: { hostId: "host_mac" },
        }),
      },
    },
    experimental_callHostRpc: async ({ method, hostId }) => {
      if (method === "run") return { exitCode: 0, output: `ran on ${hostId}\n` };
      if (missing.includes(hostId)) return { repo: "missing", repoPath: checkouts[hostId] };
      return {
        repo: "found",
        repoPath: checkouts[hostId],
        branch: "main",
        entries: [],
        skills: [],
        missingPaths: [],
      };
    },
  });
  await plugin(host.bb);
  return host.harness;
}

test("the plugin registers its RPC and CLI against the fake host", async () => {
  const harness = await load();

  assert.deepEqual([...harness.registrations.rpcMethods].sort(), [
    "hosts",
    "overview",
    "publish",
    "readFile",
    "removeSkill",
    "runTask",
    "saveFile",
    "selectHost",
  ]);

  const cli = harness.registrations.cli;
  assert.ok(cli, "server.ts registers the CLI");
  assert.equal(cli.name, "dotfiles");
  assert.deepEqual(cli.commands.map((command) => command.name).sort(), [
    "cat",
    "check",
    "list",
    "render",
    "status",
    "sync",
  ]);
});

test("a command against a missing repo exits 1 with the repo path and machine on stderr", async () => {
  const harness = await load(["host_server"]);
  assert.deepEqual(await harness.runCli(["status"]), {
    exitCode: 1,
    stdout: "",
    stderr: "dotfiles repo not found at /home/codex/git/dotfiles on linux-builder\n",
  });
});

test("an agent's command acts on its thread's machine and says so", async () => {
  const harness = await load();

  assert.deepEqual(await harness.runCli(["render"], { threadId: "thread-1" }), {
    exitCode: 0,
    stdout: "ran on host_mac\n",
    stderr: "host: Local Mac · repo: /Users/example/git/dotfiles\n",
  });
  assert.deepEqual(
    harness.experimental_hostRpcCalls.map(({ method, hostId, input }) => [method, hostId, input]),
    [
      ["inspect", "host_mac", { repoPath: "~/git/dotfiles" }],
      ["run", "host_mac", { repoPath: "~/git/dotfiles", command: "mise run render" }],
    ],
  );
});

test("a command outside a thread acts on the panel's machine", async () => {
  const harness = await load();

  assert.deepEqual(await harness.runCli(["render"]), {
    exitCode: 0,
    stdout: "ran on host_server\n",
    stderr: "host: linux-builder · repo: /home/codex/git/dotfiles\n",
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
      "bb dotfiles cat — Print a tweakable file from this thread's machine\n\n" +
      "Usage:\n  bb dotfiles cat <path>\n\n" +
      "Arguments:\n  <path>  repo-relative path (required)\n",
    stderr: "",
  });
  assert.deepEqual(await harness.runCli(["sync", "--help"]), {
    exitCode: 0,
    stdout:
      "bb dotfiles sync — Sync the repo on this thread's machine; default is consume-only, --publish pushes\n\n" +
      "Usage:\n  bb dotfiles sync [--publish]\n\n" +
      "Options:\n" +
      "  --publish   publish: rebase, push, re-apply, and render\n" +
      "  --help, -h  Show this help and exit\n",
    stderr: "",
  });
});
