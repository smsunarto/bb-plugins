import { test } from "bun:test";
import assert from "node:assert/strict";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { createDotfilesGit, type DotfilesHostClient } from "./git.ts";

const machines = {
  host_server: makeHostResponse({ id: "host_server", name: "linux-builder", status: "connected" }),
  host_dev: makeHostResponse({ id: "host_dev", name: "Build Mac", status: "connected" }),
  host_mac: makeHostResponse({ id: "host_mac", name: "Local Mac", status: "disconnected" }),
};

type HostCall = { method: string; input: unknown; options: unknown };

const inspection = {
  repoPath: "/Users/example/git/dotfiles",
  repoExists: true,
  branch: "main",
  entries: [],
  skills: [],
  missingPaths: [],
};

/** The real service over a fake bb, with every host call and its options recorded. */
function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dotfiles",
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_server" }) },
      hosts: {
        list: async () => Object.values(machines),
        get: async ({ hostId }: { hostId: string }) => ({
          ...machines[hostId as keyof typeof machines],
          connectMachineId: null,
        }),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          threadId === "thread-on-dev"
            ? { id: threadId, environment: { hostId: "host_dev" } }
            : { id: threadId },
      },
      files: {
        read: async () => ({ contentEncoding: "utf8", content: "# dotfiles\n", sha256: "sha" }),
        write: async () => ({ outcome: "written", sha256: "sha-next" }),
      },
    },
  });
  const calls: HostCall[] = [];
  const host = {
    call: async (method: string, input: unknown, options: unknown) => {
      calls.push({ method, input, options });
      return method === "inspect" ? inspection : { exitCode: 0, output: "ok" };
    },
  } as unknown as DotfilesHostClient;
  return { git: createDotfilesGit(bb, host), harness, calls };
}

test("acts on the bb server's own machine until the panel picks another", async () => {
  const { git } = setup();

  assert.deepEqual(await git.target(undefined), {
    hostId: "host_server",
    hostName: "linux-builder",
    connected: true,
    repoPath: "~/git/dotfiles",
  });

  await git.selectHost("host_dev");

  assert.equal((await git.target(undefined)).hostName, "Build Mac");
  assert.equal((await git.hosts()).selectedHostId, "host_dev");
});

test("runs a task on the target machine with room for a five-minute task", async () => {
  const { git, calls } = setup();

  await git.run(await git.target("host_dev"), "mise run check");

  assert.deepEqual(calls, [
    {
      method: "run",
      input: { repoPath: "~/git/dotfiles", command: "mise run check" },
      options: { hostId: "host_dev", timeoutMs: 310_000 },
    },
  ]);
});

test("names an offline machine instead of calling it", async () => {
  const { git, calls } = setup();

  await assert.rejects(
    async () => git.run(await git.target("host_mac"), "mise run render"),
    /^Error: Local Mac is not connected\.$/,
  );
  assert.deepEqual(calls, []);
});

test("reads and writes the checkout on the machine that was inspected", async () => {
  const { git, harness, calls } = setup();

  const repo = await git.inspect(await git.target("host_dev"));
  await git.readFile(repo, "AGENTS.md");
  await git.writeFile(repo, "AGENTS.md", "next\n", "sha");

  assert.deepEqual(calls[0]?.options, { hostId: "host_dev" });
  assert.deepEqual(harness.sdk.callsTo("files.read"), [
    [{ hostId: "host_dev", path: "/Users/example/git/dotfiles/AGENTS.md" }],
  ]);
  assert.deepEqual(harness.sdk.callsTo("files.write"), [
    [
      {
        hostId: "host_dev",
        path: "/Users/example/git/dotfiles/AGENTS.md",
        rootPath: "/Users/example/git/dotfiles",
        content: "next\n",
        expectedSha256: "sha",
      },
    ],
  ]);
});

test("finds the machine an agent's thread runs on", async () => {
  const { git } = setup();

  assert.equal(await git.threadHostId("thread-on-dev"), "host_dev");
  assert.equal(await git.threadHostId("thread-without-environment"), undefined);
});
