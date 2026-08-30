import { describe, expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

const hostSnapshot = {
  gitButlerVersion: "0.22.3" as const,
  capturedAt: 1,
  mergeBase: null,
  upstream: { behind: 0, lastFetched: null },
  stacks: [],
  worktree: { files: [], hunkCount: 0 },
};

function readyEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    hostId: "host-remote",
    path: "/remote/repo",
    status: "ready",
    isGitRepo: true,
    isWorktree: false,
    ...overrides,
  } as never;
}

describe("GitButler server routing", () => {
  test("composes exactly two RPC units and routes path internally to an explicit host", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitbutler",
      sdk: {
        threads: {
          get: async () => ({ environmentId: "env-1", status: "idle" }) as never,
        },
        environments: {
          get: async () => readyEnvironment(),
        },
      },
      experimental_callHostRpc: async ({ method }) => {
        expect(method).toBe("inspectRepository");
        return { kind: "ready", repository: hostSnapshot };
      },
    });
    await plugin(bb);
    expect([...harness.registrations.rpcMethods].sort()).toEqual(["commitSelection", "repository"]);

    const result = await harness.behavior.callRpc("repository", { threadId: "thread-1" });
    expect(result).toMatchObject({
      repository: { kind: "ready", repository: { environmentId: "env-1" } },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
      method: "inspectRepository",
      hostId: "host-remote",
      input: { repositoryPath: "/remote/repo" },
    });
  });

  test("strict browser schemas reject host routing and command fields", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "gitbutler" });
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("repository", {
        threadId: "thread-1",
        cwd: "/repo",
        hostId: "host-1",
        argv: ["status"],
      }),
    ).rejects.toThrow(/input validation failed/u);
  });

  test("rejects linked worktrees before a host call", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitbutler",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1", status: "idle" }) as never },
        environments: { get: async () => readyEnvironment({ isWorktree: true }) },
      },
    });
    await plugin(bb);
    await expect(
      harness.behavior.callRpc("repository", { threadId: "thread-1" }),
    ).resolves.toMatchObject({
      repository: { kind: "unavailable", issue: { code: "linked-worktree" } },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  test("blocks mutation while a thread is starting, active, or stopping", async () => {
    for (const status of ["starting", "active", "stopping"] as const) {
      const { bb, harness } = createFakePluginHost({
        pluginId: "gitbutler",
        sdk: {
          threads: { get: async () => ({ environmentId: "env-1", status }) as never },
          environments: { get: async () => readyEnvironment() },
        },
      });
      await plugin(bb);
      await expect(
        harness.behavior.callRpc("commitSelection", {
          threadId: "thread-1",
          intent: {
            message: "message",
            target: { kind: "existing", branchName: "scott/alpha" },
            hunkKeys: [`h1:${"a".repeat(64)}`],
          },
        }),
      ).resolves.toMatchObject({ outcome: { kind: "rejected", code: "thread-active" } });
      expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
    }
  });

  test("routes mutation intent to the current environment host", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitbutler",
      sdk: {
        threads: { get: async () => ({ environmentId: "env-1", status: "idle" }) as never },
        environments: { get: async () => readyEnvironment() },
      },
      experimental_callHostRpc: async () => ({
        outcome: { kind: "rejected", code: "selection-stale", message: "stale" },
        repository: hostSnapshot,
      }),
    });
    await plugin(bb);
    const hunkKey = `h1:${"a".repeat(64)}`;
    await harness.behavior.callRpc("commitSelection", {
      threadId: "thread-1",
      intent: {
        message: "message",
        target: { kind: "existing", branchName: "scott/alpha" },
        hunkKeys: [hunkKey],
      },
    });
    expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
      method: "commitSelection",
      hostId: "host-remote",
      input: {
        repositoryPath: "/remote/repo",
        intent: { hunkKeys: [hunkKey] },
      },
    });
  });
});
