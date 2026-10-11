import { expect, test } from "bun:test";
import { callProcedure } from "@bb-kit/core/rpc";
import { fakeContext } from "../../../test/fake-gh.ts";
import { BOTTOM, TOP, UNPUBLISHED, fakeGitButler } from "../../../test/fake-gitbutler.ts";
import { branchActivity } from "./branch-activity.ts";
import { startLocalReview } from "./start-local-review.ts";

const RATE_LIMIT = "16ea307183d0";
const NAV = "f1b4224d3a52";

const PROJECT = {
  id: "p-api",
  gitRemoteUrl: "git@github.com:acme/api.git",
  sources: [{ hostId: "host-9", path: "/srv/api", isDefault: true }],
};

function context(
  options: { projects?: unknown[]; environments?: unknown[]; unpublished?: unknown } = {},
) {
  const status = new Map<string, string>();
  return {
    status,
    ...fakeContext(
      {},
      {
        plugins: fakeGitButler({ unpublishedBranches: () => options.unpublished ?? UNPUBLISHED }),
        projects: { list: async () => options.projects ?? [PROJECT] },
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
    ),
  };
}

test("reviews the branch in the checkout that holds it, read-only, and links it to the branch", async () => {
  const { ctx, harness } = context();

  expect(await callProcedure(startLocalReview, ctx, { id: RATE_LIMIT })).toEqual({
    threadId: "thr_1",
  });

  const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [[Record<string, unknown>]];
  const { prompt, ...args } = spawn;
  expect(args).toEqual({
    // The checkout is not this project's source, but it is its repository.
    projectId: "p-api",
    environment: {
      type: "host",
      hostId: "host-1",
      workspace: { type: "unmanaged", path: "/home/scott/git/api" },
    },
    reasoningLevel: "high",
    visibility: "visible",
    title: "Review scott/rate-limit",
    pluginMetadata: { kind: "review", branch: RATE_LIMIT, headRefOid: TOP },
    origin: "plugin",
    originPluginId: "code-review",
  });
  expect(prompt).toContain(`Review \`git diff ${BOTTOM} ${TOP}\``);
  expect(prompt).toContain(`- Base: \`${BOTTOM}\`, the head of \`scott/login-copy\``);
  expect(prompt).toContain("Do not modify files, check out, reset, stash, clean, commit");

  expect(await callProcedure(branchActivity, ctx, { id: RATE_LIMIT })).toMatchObject({
    threads: [
      {
        threadId: "thr_1",
        kind: "review",
        status: "active",
        headRefOid: TOP,
        baseRefName: BOTTOM,
      },
    ],
  });
});

test("asking again while the review of this head runs opens that review", async () => {
  const { ctx, harness, status } = context();

  await callProcedure(startLocalReview, ctx, { id: RATE_LIMIT });
  expect(await callProcedure(startLocalReview, ctx, { id: RATE_LIMIT })).toEqual({
    threadId: "thr_1",
  });
  status.set("thr_1", "idle");
  expect(await callProcedure(startLocalReview, ctx, { id: RATE_LIMIT })).toEqual({
    threadId: "thr_2",
  });
  expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
});

test("the checkout's ready environment is reused, in its own project", async () => {
  const { ctx, harness } = context({
    projects: [PROJECT, { id: "p-other", gitRemoteUrl: null, sources: [] }],
    environments: [
      {
        id: "env-1",
        projectId: "p-other",
        status: "ready",
        hostId: "host-1",
        path: "/home/scott/git/api",
      },
    ],
  });

  await callProcedure(startLocalReview, ctx, { id: RATE_LIMIT });

  expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    projectId: "p-other",
    environment: { type: "reuse", environmentId: "env-1" },
  });
});

test("a checkout no project knows, with no GitHub origin, asks for a project", async () => {
  const { ctx, harness } = context();

  await expect(callProcedure(startLocalReview, ctx, { id: NAV })).rejects.toThrow(
    "Add web as a bb project to review it with bb.",
  );
  expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
});

test("a project whose source is the checkout takes it, whatever its remote", async () => {
  const { ctx, harness } = context({
    projects: [
      PROJECT,
      {
        id: "p-web",
        gitRemoteUrl: null,
        sources: [{ hostId: "host-2", path: "/Users/scott/web", isDefault: true }],
      },
    ],
  });

  await callProcedure(startLocalReview, ctx, { id: NAV });

  expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
    projectId: "p-web",
    environment: {
      type: "host",
      hostId: "host-2",
      workspace: { type: "unmanaged", path: "/Users/scott/web" },
    },
  });
});

test("a branch that was published since the page loaded is not reviewed", async () => {
  const { ctx, harness } = context();

  await expect(callProcedure(startLocalReview, ctx, { id: "000000000000" })).rejects.toThrow(
    "That branch has no unpublished commits any more",
  );
  expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
});

test("a checkout under an environment's repos/ is reviewed in that environment's project", async () => {
  const nav = UNPUBLISHED.branches[2]!;
  const { ctx, harness } = context({
    unpublished: { branches: [{ ...nav, path: "/work/group/repos/web" }] },
    projects: [PROJECT, { id: "p-group", gitRemoteUrl: null, sources: [] }],
    environments: [
      { id: "env-g", projectId: "p-group", status: "ready", hostId: "host-2", path: "/work/group" },
    ],
  });

  await callProcedure(startLocalReview, ctx, { id: "51c60eab16c1" });

  const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [[Record<string, unknown>]];
  expect(spawn).toMatchObject({
    projectId: "p-group",
    environment: { type: "reuse", environmentId: "env-g" },
  });
  expect(spawn["prompt"]).toContain("Run git in the checkout, `/work/group/repos/web`.");
});
