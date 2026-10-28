import { expect, test } from "bun:test";
import { fakeContext } from "../../../test/fake-gh.ts";
import { startReview } from "./start-review.ts";

const REF = { owner: "Cli", repo: "cli", number: 9000 };
const HEAD = {
  repository: {
    pullRequest: {
      number: 9000,
      title: "proof of concept for flag-level disable auth check",
      url: "https://github.com/cli/cli/pull/9000",
      headRefName: "andyfeller/flag-level-disableauth",
      baseRefName: "trunk",
      headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
      baseRefOid: "28c4d3075b5916acdb6974a7e4f5c49d2c274a86",
      isCrossRepository: false,
    },
  },
};

function context(
  options: { projects?: unknown[]; environments?: unknown[]; head?: () => unknown } = {},
) {
  const status = new Map<string, string>();
  const project = {
    id: "p-cli",
    gitRemoteUrl: "https://github.com/cli/cli.git",
    sources: [{ hostId: "host-1", isDefault: true }],
  };
  const fake = fakeContext(
    { graphql: { PullRequestHead: options.head ?? HEAD } },
    {
      projects: { list: async () => options.projects ?? [project] },
      environments: { list: async () => options.environments ?? [] },
      threads: {
        spawn: async () => {
          const id = `thr_${status.size + 1}`;
          status.set(id, "active");
          return { id };
        },
        get: async ({ threadId }) => ({
          id: threadId,
          title: null,
          titleFallback: null,
          deletedAt: null,
          status: status.get(threadId),
        }),
      },
    },
  );
  return { ...fake, status };
}

test("starts a high-effort bb review in a fresh worktree and links it to the pull request", async () => {
  const { ctx, harness } = context();
  await ctx.store.setInstructions("Watch the auth paths.");

  expect(await startReview(ctx, { account: "octocat", ref: REF })).toEqual({
    threadId: "thr_1",
  });

  const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [[Record<string, unknown>]];
  const { prompt, ...args } = spawn;
  // No provider is pinned, so bb starts the review on its default agent.
  expect(args).not.toHaveProperty("providerId");
  expect(args).toMatchObject({
    projectId: "p-cli",
    environment: {
      type: "host",
      hostId: "host-1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
    reasoningLevel: "high",
    visibility: "visible",
    title: "Review Cli/cli#9000",
    pluginMetadata: {
      kind: "review",
      pr: "Cli/cli#9000",
      headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
    },
  });
  expect(prompt).toContain("git checkout --detach cc36d32a212a2b8b6611fb73549fe6d04fb6ec38");
  expect(prompt).toContain("## The reviewer's instructions\n\nWatch the auth paths.");
  expect(await ctx.store.linkForThread("thr_1")).toMatchObject({
    key: "Cli/cli#9000",
    link: {
      threadId: "thr_1",
      kind: "review",
      headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
      baseRefName: "trunk",
    },
  });
  expect(harness.inspection.realtimeSignals).toEqual([
    { channel: "agent-activity", payload: { key: "Cli/cli#9000" } },
  ]);
});

test("asking again while the review of this commit runs returns that review", async () => {
  const { ctx, harness, status } = context();
  await startReview(ctx, { account: "octocat", ref: REF });

  expect(await startReview(ctx, { account: "octocat", ref: REF })).toEqual({
    threadId: "thr_1",
  });
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);

  status.set("thr_1", "idle");
  expect(await startReview(ctx, { account: "octocat", ref: REF })).toEqual({
    threadId: "thr_2",
  });
});

test("after a retarget, asking again starts a review against the new base", async () => {
  let baseRefName = "trunk";
  const { ctx, harness } = context({
    head: () => ({
      repository: { pullRequest: { ...HEAD.repository.pullRequest, baseRefName } },
    }),
  });
  await startReview(ctx, { account: "octocat", ref: REF });

  // Same head, so only the base says the running review read another diff.
  baseRefName = "release";
  expect(await startReview(ctx, { account: "octocat", ref: REF })).toEqual({
    threadId: "thr_2",
  });
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
  expect(await ctx.store.linkForThread("thr_2")).toMatchObject({
    link: { baseRefName: "release" },
  });
});

test("two requests at once start one review and both answer it", async () => {
  const { ctx, harness } = context();

  const answers = await Promise.all([
    startReview(ctx, { account: "octocat", ref: REF }),
    startReview(ctx, { account: "octocat", ref: { ...REF, owner: "cli" } }),
  ]);

  expect(answers).toEqual([{ threadId: "thr_1" }, { threadId: "thr_1" }]);
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

test("reviews in the environment already on the branch, leaving its working tree alone", async () => {
  const { ctx, harness } = context({
    environments: [
      { id: "env-7", status: "ready", branchName: "andyfeller/flag-level-disableauth" },
    ],
  });

  await startReview(ctx, { account: "octocat", ref: REF });

  const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [
    [{ environment: unknown; prompt: string }],
  ];
  expect(spawn.environment).toEqual({ type: "reuse", environmentId: "env-7" });
  expect(spawn.prompt).toContain("Do not check out, reset, stash, or clean anything.");
});

test("a repository that is not a bb project is named in the error", async () => {
  const { ctx, harness } = context({ projects: [] });
  await expect(startReview(ctx, { account: "octocat", ref: REF })).rejects.toThrow(
    "Add Cli/cli as a bb project to review it with bb.",
  );
  expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
});
