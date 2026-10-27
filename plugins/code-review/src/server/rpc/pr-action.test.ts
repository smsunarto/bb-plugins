import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { prAction } from "./pr-action.ts";

const ref = { owner: "cli", repo: "cli", number: 14572 };
function setup(
  edit: (pr: {
    state: string;
    isDraft: boolean;
    headRefOid: string;
    baseRefName: string;
    mergeStateStatus: string;
    viewerCanUpdate: boolean;
  }) => void = () => {},
  merged = true,
) {
  const pr = {
    state: "OPEN",
    isDraft: false,
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    mergeStateStatus: "CLEAN",
    viewerCanUpdate: true,
  };
  edit(pr);
  const { ctx, calls } = fakeContext({
    graphql: {
      PrActionState: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: false,
          viewerPermission: "WRITE",
          pullRequest: pr,
        },
      },
    },
    rest: { "repos/cli/cli/pulls/14572/merge": { merged, message: "Merge refused" } },
  });
  const textCalls: { account: string; args: string[] }[] = [];
  const as = ctx.github.as.bind(ctx.github);
  ctx.github.as = (account) => ({
    ...as(account),
    text: async (args) => {
      textCalls.push({ account, args });
      return "";
    },
  });
  return { ctx, calls, textCalls, headRefOid: pr.headRefOid };
}

test("merge acts as the selected account and sends the confirmed head and method", async () => {
  const { ctx, calls, headRefOid } = setup();
  await callProcedure(prAction, ctx, {
    account: "octocat",
    ref,
    action: "merge",
    headRefOid,
    baseRefName: "main",
    method: "squash",
  });
  expect(calls.at(-1)).toEqual({
    kind: "rest",
    method: "PUT",
    path: "repos/cli/cli/pulls/14572/merge",
    account: "octocat",
    body: { sha: headRefOid, merge_method: "squash" },
  });
});

for (const action of ["close", "reopen", "draft", "ready"] as const) {
  test(`${action} uses the explicit repository, number, and selected account`, async () => {
    const { ctx, textCalls, headRefOid } = setup((pr) => {
      if (action === "reopen") pr.state = "CLOSED";
      if (action === "ready") pr.isDraft = true;
    });
    await callProcedure(prAction, ctx, {
      account: "octocat",
      ref,
      action,
      headRefOid,
      baseRefName: "main",
      method: "squash",
    });
    expect(textCalls).toEqual([
      {
        account: "octocat",
        args: [
          "pr",
          action === "draft" ? "ready" : action,
          "14572",
          "--repo",
          "cli/cli",
          ...(action === "draft" ? ["--undo"] : []),
        ],
      },
    ]);
  });
}

test("a changed head cannot merge", async () => {
  const { ctx, calls } = setup();
  await expect(
    callProcedure(prAction, ctx, {
      account: "octocat",
      ref,
      action: "merge",
      headRefOid: "old-head",
      baseRefName: "main",
      method: "squash",
    }),
  ).rejects.toThrow("branch changed");
  expect(calls.some((call) => call.kind === "rest")).toBe(false);
});

test("GitHub refusing a merge never reports success", async () => {
  const { ctx, headRefOid } = setup(() => {}, false);
  await expect(
    callProcedure(prAction, ctx, {
      account: "octocat",
      ref,
      action: "merge",
      headRefOid,
      baseRefName: "main",
      method: "squash",
    }),
  ).rejects.toThrow("Merge refused");
});

test("a draft cannot merge and a merged PR cannot close", async () => {
  for (const state of ["draft", "merged"] as const) {
    const { ctx, calls, textCalls, headRefOid } = setup((pr) => {
      if (state === "draft") pr.isDraft = true;
      else pr.state = "MERGED";
    });
    await expect(
      callProcedure(prAction, ctx, {
        account: "octocat",
        ref,
        action: state === "draft" ? "merge" : "close",
        headRefOid,
        baseRefName: "main",
        method: "squash",
      }),
    ).rejects.toThrow();
    expect(calls.some((call) => call.kind === "rest")).toBe(false);
    expect(textCalls).toHaveLength(0);
  }
});

test("blocked branch rules and forbidden updates fail before a write", async () => {
  for (const mode of ["blocked", "permission"] as const) {
    const { ctx, calls, textCalls, headRefOid } = setup((pr) => {
      if (mode === "blocked") pr.mergeStateStatus = "BLOCKED";
      else pr.viewerCanUpdate = false;
    });
    await expect(
      callProcedure(prAction, ctx, {
        account: "octocat",
        ref,
        action: mode === "blocked" ? "merge" : "close",
        headRefOid,
        baseRefName: "main",
        method: "squash",
      }),
    ).rejects.toThrow();
    expect(calls.some((call) => call.kind === "rest")).toBe(false);
    expect(textCalls).toHaveLength(0);
  }
});

test("repository-disallowed merge methods are refused", async () => {
  const { ctx, headRefOid, calls } = setup();
  await expect(
    callProcedure(prAction, ctx, {
      account: "octocat",
      ref,
      action: "merge",
      headRefOid,
      baseRefName: "main",
      method: "rebase",
    }),
  ).rejects.toThrow("does not allow");
  expect(calls.some((call) => call.kind === "rest")).toBe(false);
});

test("a retargeted destination cannot merge", async () => {
  const { ctx, calls, headRefOid } = setup((pr) => {
    pr.baseRefName = "release";
  });
  await expect(
    callProcedure(prAction, ctx, {
      account: "octocat",
      ref,
      action: "merge",
      headRefOid,
      baseRefName: "main",
      method: "squash",
    }),
  ).rejects.toThrow("destination branch changed");
  expect(calls.some((call) => call.kind === "rest")).toBe(false);
});
