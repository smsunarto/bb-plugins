import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { BASE, TOP, UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { branchId } from "../lib/gitbutler.ts";

const branch = UNPUBLISHED.branches[1]!;
const range = { id: branchId(branch.hostId, branch.path, branch.branch), base: BASE, head: TOP };

test("a shared comparison survives publication and reload using its saved checkout and exact range", async () => {
  const { bb, harness: initial } = createFakePluginHost({
    pluginId: "code-review",
    sdk: { plugins: fakeGitButler({ unpublishedBranches: () => ({ branches: [branch] }) }) },
  });
  await plugin(bb);
  let harness = initial;
  try {
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, hostId: branch.hostId, path: branch.path },
    });
    ({ harness } = await harness.lifecycle.reload(plugin));
    harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("No unpublished branches");
    });
    expect(await harness.behavior.callRpc("sharedComparison", range)).toEqual({
      ...range,
      hostId: branch.hostId,
      path: branch.path,
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a legacy card resolves only its thread's checkout even with no unpublished branches", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async () => ({
          environment: { hostId: "personal-mac", path: "/Users/scott/git/recipe", status: "ready" },
        }),
      },
    },
  });
  await plugin(bb);
  try {
    expect(
      await harness.behavior.callRpc("sharedComparison", { ...range, threadId: "shipped-thread" }),
    ).toEqual({
      ...range,
      hostId: "personal-mac",
      path: "/Users/scott/git/recipe",
    });
    expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    await expect(
      harness.behavior.callRpc("sharedComparison", { ...range, head: "main" }),
    ).rejects.toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a missing checkout does not fabricate a readable comparison", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: { threads: { get: async () => ({ environment: null }) } },
  });
  await plugin(bb);
  try {
    await expect(
      harness.behavior.callRpc("sharedComparison", { ...range, threadId: "gone" }),
    ).rejects.toThrow("checkout");
  } finally {
    await harness.lifecycle.dispose();
  }
});
