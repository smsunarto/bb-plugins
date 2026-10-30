import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { branchId } from "../lib/gitbutler.ts";
import plugin from "../server.ts";

test("the share tool returns valid branch and PR cards, refuses missing or ambiguous branches", async () => {
  let branches = UNPUBLISHED.branches;
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async () => ({
          environment: { hostId: "host-1", path: "/home/example/git/api", status: "ready" },
        }),
      },
      plugins: fakeGitButler({ unpublishedBranches: () => ({ branches }) }),
    },
  });
  await plugin(bb);
  const branch = UNPUBLISHED.branches[1]!;
  const id = branchId(branch.hostId, branch.path, branch.branch);
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch },
    }),
  ).toBe(`::code-review{branch="${id}" base="${branch.base}" head="${branch.head}"}`);
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "pr", reference: "https://github.com/acme/api/pull/42", account: "scott" },
    }),
  ).toBe('::code-review{pr="acme/api#42" account="scott"}');
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: "missing" },
    }),
  ).rejects.toThrow("No unpublished branch");
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "pr", reference: "javascript:alert(1)" },
    }),
  ).rejects.toThrow("GitHub pull request");
  branches = [branch, { ...branch, hostId: "other-host" }];
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch },
    }),
  ).toContain(`branch="${id}"`);
  branches = [branch, { ...branch, path: "/home/example/other" }];
  await expect(
    harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, hostId: branch.hostId },
    }),
  ).rejects.toThrow("Several checkouts match");
  branches = [branch];
  expect(
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, hostId: branch.hostId, path: branch.path },
    }),
  ).toContain(`branch="${id}"`);
  await harness.lifecycle.dispose();
});

test("sharing scopes discovery to the calling checkout and retains its resolved repository path", async () => {
  const branch = UNPUBLISHED.branches[1]!;
  const inputs: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async () => ({
          environment: { hostId: branch.hostId, path: "/linked/checkout", status: "ready" },
        }),
      },
      plugins: fakeGitButler({
        unpublishedBranches: () => {
          throw new Error("Fleet discovery must not run");
        },
        unpublishedBranchesAt: (input) => {
          inputs.push(input);
          return { branches: [branch] };
        },
      }),
    },
  });
  await plugin(bb);
  try {
    const card = await harness.behavior.callAgentTool(
      "code_review_share_changes",
      { target: { kind: "branch", branch: branch.branch } },
      { threadId: "calling-thread" },
    );
    expect(harness.inspection.sdk.callsTo("threads.get")[0]).toEqual([
      { threadId: "calling-thread", include: "environment" },
    ]);
    expect(inputs).toEqual([{ hostId: branch.hostId, path: "/linked/checkout" }]);
    expect(card).toContain(`branch="${branchId(branch.hostId, branch.path, branch.branch)}"`);
    await harness.behavior.callAgentTool("code_review_share_changes", {
      target: { kind: "branch", branch: branch.branch, path: "/another/checkout" },
    });
    expect(inputs[1]).toEqual({ hostId: branch.hostId, path: "/another/checkout" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test.each([
  null,
  { hostId: "host-1", path: null, status: "ready" },
  { hostId: "host-1", path: "/pending", status: "provisioning" },
])(
  "sharing without a ready checkout fails locally; explicit targets and PRs still work (%j)",
  async (environment) => {
    const branch = UNPUBLISHED.branches[1]!;
    const { bb, harness } = createFakePluginHost({
      pluginId: "code-review",
      sdk: {
        threads: { get: async () => ({ environment }) },
        plugins: fakeGitButler({ unpublishedBranchesAt: () => ({ branches: [branch] }) }),
      },
    });
    await plugin(bb);
    try {
      await expect(
        harness.behavior.callAgentTool("code_review_share_changes", {
          target: { kind: "branch", branch: branch.branch },
        }),
      ).rejects.toThrow("no ready checkout");
      expect(harness.inspection.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
      await harness.behavior.callAgentTool("code_review_share_changes", {
        target: { kind: "branch", branch: branch.branch, hostId: branch.hostId, path: branch.path },
      });
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
      expect(
        await harness.behavior.callAgentTool("code_review_share_changes", {
          target: { kind: "pr", reference: "acme/api#42" },
        }),
      ).toBe('::code-review{pr="acme/api#42"}');
      expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

test("a failed scoped read propagates cancellation and never falls back to other hosts", async () => {
  const branch = UNPUBLISHED.branches[1]!;
  const controller = new AbortController();
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      plugins: fakeGitButler({
        unpublishedBranchesAt: () => {
          throw new Error("Checkout unavailable");
        },
      }),
    },
  });
  await plugin(bb);
  try {
    await expect(
      harness.behavior.callAgentTool(
        "code_review_share_changes",
        {
          target: {
            kind: "branch",
            branch: branch.branch,
            hostId: branch.hostId,
            path: branch.path,
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Checkout unavailable");
    const calls = harness.inspection.sdk.callsTo("plugins.callRpc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      method: "unpublishedBranchesAt",
      signal: controller.signal,
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a group keeps exact checkout identities and accounts in one shipping card", async () => {
  const branch = UNPUBLISHED.branches[1]!;
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: { plugins: fakeGitButler({ unpublishedBranchesAt: () => ({ branches: [branch] }) }) },
  });
  await plugin(bb);
  try {
    const result = await harness.behavior.callAgentTool("code_review_share_changes", {
      targets: [
        { kind: "branch", branch: branch.branch, hostId: branch.hostId, path: branch.path },
        { kind: "pr", reference: "https://github.com/acme/api/pull/42", account: "scott" },
        { kind: "pr", reference: "acme/web#7" },
      ],
    });
    expect(typeof result).toBe("string");
    const encoded = String(result).match(/^::code-review\{targets="([^"]+)"\}$/)?.[1];
    expect(encoded).toBeDefined();
    const group = JSON.parse(decodeURIComponent(encoded!));
    expect(group).toEqual([
      {
        branch: branchId(branch.hostId, branch.path, branch.branch),
        base: branch.base,
        head: branch.head,
        branchName: branch.branch,
        hostId: branch.hostId,
        path: branch.path,
      },
      { pr: "acme/api#42", account: "scott" },
      { pr: "acme/web#7" },
    ]);
    const prompt = await harness.behavior.callRpc("shipGroupPrompt", { targets: group });
    expect(prompt).toContain(branch.path);
    expect(prompt).toContain(branch.head);
    expect(prompt).toContain("acme/web#7");
    expect(prompt).toContain("review the new changes before shipping");
    await expect(
      harness.behavior.callAgentTool("code_review_share_changes", {
        targets: [
          { kind: "pr", reference: "acme/api#42" },
          { kind: "pr", reference: "ACME/API#42" },
        ],
      }),
    ).rejects.toThrow("distinct targets");
    await expect(
      harness.behavior.callAgentTool("code_review_share_changes", {
        targets: [
          { kind: "pr", reference: "acme/api#42", account: "scott" },
          { kind: "pr", reference: "acme/api#42", account: "other" },
        ],
      }),
    ).rejects.toThrow("distinct targets");
    await expect(
      harness.behavior.callAgentTool("code_review_share_changes", {
        target: { kind: "pr", reference: "acme/api#42" },
        targets: [
          { kind: "pr", reference: "acme/api#1" },
          { kind: "pr", reference: "acme/api#2" },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callAgentTool("code_review_share_changes", {
        targets: [
          { kind: "pr", reference: "acme/api#42" },
          { kind: "pr", reference: "invalid" },
        ],
      }),
    ).rejects.toThrow("GitHub pull request");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("shipping refuses a branch whose displayed ID disagrees with its checkout", async () => {
  const branch = UNPUBLISHED.branches[1]!;
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review" });
  await plugin(bb);
  try {
    await expect(
      harness.behavior.callRpc("shipGroupPrompt", {
        targets: [
          {
            branch: branchId(branch.hostId, branch.path, branch.branch),
            base: branch.base,
            head: branch.head,
            branchName: "main",
            hostId: branch.hostId,
            path: "/another/repository",
          },
          { pr: "acme/api#42" },
        ],
      }),
    ).rejects.toThrow("does not match");
    await expect(
      harness.behavior.callRpc("shipGroupPrompt", {
        targets: [
          { pr: "acme/api#42", account: "scott" },
          { pr: "https://github.com/acme/api/pull/42", account: "other" },
        ],
      }),
    ).rejects.toThrow("rpc input validation failed");
  } finally {
    await harness.lifecycle.dispose();
  }
});
