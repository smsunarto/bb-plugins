import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { startFix } from "./start-fix.ts";

const REQUEST = {
  projectId: "p-api",
  providerId: "codex",
  model: "gpt-6",
  reasoningLevel: "high",
  permissionMode: "auto",
  executionInputSources: {},
  environment: { type: "project-default" },
  input: [{ type: "text", text: "Fix the failing checks…", mentions: [] }],
};

/** The pull request's head and base as GitHub has them now. */
const HEAD = {
  repository: {
    pullRequest: {
      number: 1034,
      title: "Retry webhooks",
      url: "https://github.com/acme/api/pull/1034",
      headRefName: "retry",
      baseRefName: "release",
      headRefOid: "abc",
      baseRefOid: "def",
      isCrossRepository: false,
    },
  },
};

test("spawns the composed thread, titled and linked to the pull request and its base", async () => {
  const { ctx, harness } = fakeContext(
    { graphql: { PullRequestHead: HEAD } },
    { threads: { spawn: async () => ({ id: "thr_fix" }) } },
  );
  const ref = { owner: "acme", repo: "api", number: 1034 };

  expect(
    await callProcedure(startFix, ctx, {
      account: "octocat",
      ref,
      headRefOid: "abc",
      request: REQUEST,
    }),
  ).toEqual({
    threadId: "thr_fix",
  });

  expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    ...REQUEST,
    title: "Fix checks on acme/api#1034",
    visibility: "visible",
    pluginMetadata: { kind: "fix", pr: "acme/api#1034" },
  });
  expect(await ctx.store.linkForThread("thr_fix")).toMatchObject({
    link: { threadId: "thr_fix", kind: "fix", headRefOid: "abc", baseRefName: "release" },
  });
  expect(harness.inspection.realtimeSignals).toEqual([
    { channel: "agent-activity", payload: { key: "acme/api#1034" } },
  ]);
});

test("refuses something that is not a new-thread request", async () => {
  const { ctx } = fakeContext();
  await expect(
    callProcedure(startFix, ctx, {
      account: "octocat",
      ref: { owner: "acme", repo: "api", number: 1 },
      headRefOid: "abc",
      request: { prompt: "hi" },
    }),
  ).rejects.toThrow("invalid input");
});
