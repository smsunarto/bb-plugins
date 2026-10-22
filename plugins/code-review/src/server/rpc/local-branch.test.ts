import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { branchId } from "../lib/gitbutler.ts";
import plugin from "../server.ts";

const branch = UNPUBLISHED.branches[1]!;
const id = branchId(branch.hostId, branch.path, branch.branch);

test("a legacy card finds its branch without waiting for another host, then targets its checkout after reload", async () => {
  const inputs: unknown[] = [];
  let moved = false;
  const { bb, harness: initial } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      hosts: {
        list: async () => [
          { id: "slow-host", status: "connected" },
          { id: branch.hostId, status: "connected" },
          { id: "asleep", status: "disconnected" },
        ],
      },
      plugins: fakeGitButler({
        unpublishedBranches: (input) => {
          inputs.push(input);
          const scope = input as { hostId: string; path?: string };
          if (scope.hostId === "slow-host") return new Promise(() => {});
          return { branches: [{ ...branch, head: moved ? "d".repeat(40) : branch.head }] };
        },
      }),
    },
  });
  await plugin(bb);
  let harness = initial;
  try {
    expect(await harness.behavior.callRpc("localBranch", { id })).toMatchObject({
      id,
      head: branch.head,
    });
    expect(inputs).toEqual([{ hostId: "slow-host" }, { hostId: branch.hostId }]);
    ({ harness } = await harness.lifecycle.reload(plugin));
    inputs.length = 0;
    moved = true;
    expect(await harness.behavior.callRpc("localBranch", { id })).toMatchObject({
      id,
      head: "d".repeat(40),
    });
    expect(inputs).toEqual([{ hostId: branch.hostId, path: branch.path }]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("sharing a located branch seeds direct reads and failures never fall back to fleet discovery", async () => {
  const inputs: unknown[] = [];
  let fail = false;
  let published = false;
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      plugins: fakeGitButler({
        unpublishedBranches: (input) => {
          inputs.push(input);
          if (fail) throw new Error("Workspace unavailable");
          return { branches: published ? [] : [branch] };
        },
      }),
    },
  });
  await plugin(bb);
  try {
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, hostId: branch.hostId, path: branch.path },
    });
    expect(inputs).toEqual([{ hostId: branch.hostId, path: branch.path }]);
    inputs.length = 0;
    fail = true;
    await expect(harness.behavior.callRpc("localBranch", { id })).rejects.toThrow(
      "Workspace unavailable",
    );
    expect(inputs).toEqual([{ hostId: branch.hostId, path: branch.path }]);
    fail = false;
    published = true;
    await expect(harness.behavior.callRpc("localBranch", { id })).rejects.toThrow(
      "no longer unpublished",
    );
    await expect(harness.behavior.callRpc("localBranch", { id: "../outside" })).rejects.toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an old card's own checkout bypasses slow repositories on the same machine", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      hosts: { list: async () => [{ id: branch.hostId, status: "connected" }] },
      threads: {
        get: async () => ({
          environment: { hostId: branch.hostId, path: branch.path, status: "ready" },
        }),
      },
      plugins: fakeGitButler({
        unpublishedBranches: (input) => {
          const scope = input as { hostId: string; path?: string };
          return scope.path === branch.path ? { branches: [branch] } : new Promise(() => {});
        },
      }),
    },
  });
  await plugin(bb);
  try {
    expect(
      await harness.behavior.callRpc("localBranch", { id, threadId: "thread-1" }),
    ).toMatchObject({ id });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("missing legacy cards share one in-flight discovery per host", async () => {
  let finish: ((value: { branches: [] }) => void) | undefined;
  const pending = new Promise<{ branches: [] }>((resolve) => {
    finish = resolve;
  });
  let ready: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const inputs: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      hosts: {
        list: async () => [
          { id: "a", status: "connected" },
          { id: "b", status: "connected" },
        ],
      },
      plugins: fakeGitButler({
        unpublishedBranches: (input) => {
          inputs.push(input);
          if (inputs.length === 2) ready?.();
          return pending;
        },
      }),
    },
  });
  await plugin(bb);
  try {
    const reads = ["000000000000", "111111111111"].map((id) =>
      harness.behavior.callRpc("localBranch", { id }),
    );
    await started;
    finish?.({ branches: [] });
    const outcomes = await Promise.allSettled(reads);
    expect(inputs).toEqual([{ hostId: "a" }, { hostId: "b" }]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected")
        expect(outcome.reason.message).toBe(
          "This branch is no longer unpublished, or its machine is offline.",
        );
    }
  } finally {
    finish?.({ branches: [] });
    await harness.lifecycle.dispose();
  }
});
