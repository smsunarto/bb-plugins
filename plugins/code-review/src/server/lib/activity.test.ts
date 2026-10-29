import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { agentActivity, linkThread, runningReview } from "./activity.ts";
import { createStore } from "./store.ts";

const KEY = "cli/cli#9000";

function host(
  threads: Record<string, { status: string; title?: string | null; deletedAt?: number }>,
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads[threadId];
          if (!thread)
            throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404 });
          return {
            id: threadId,
            title: null,
            titleFallback: "Untitled",
            deletedAt: null,
            ...thread,
          };
        },
      },
    },
  });
  return { bb, harness, store: createStore(bb.storage.kv) };
}

const run = (threadId: string, headRefOid: string) => ({
  threadId,
  headRefOid,
  baseRefName: "main",
  reportedAt: "2026-10-01T00:00:00.000Z",
  summary: "Looks right.",
  findings: [],
});

test("linked threads read their live status; a deleted one reads as missing", async () => {
  const { bb, store, harness } = host({
    t1: { status: "idle", title: "Review cli/cli#9000" },
    t3: { status: "active", deletedAt: 5 },
  });
  await linkThread(bb, store, KEY, {
    threadId: "t1",
    kind: "review",
    headRefOid: "old",
    baseRefName: "main",
  });
  await linkThread(bb, store, KEY, {
    threadId: "t2",
    kind: "fix",
    headRefOid: "old",
    baseRefName: "main",
  });
  await linkThread(bb, store, KEY, {
    threadId: "t3",
    kind: "fix",
    headRefOid: "new",
    baseRefName: "main",
  });

  const activity = await agentActivity(bb, store, KEY);

  expect(activity.threads.map(({ createdAt: _createdAt, ...thread }) => thread)).toEqual([
    {
      threadId: "t3",
      kind: "fix",
      title: null,
      status: "missing",
      headRefOid: "new",
      baseRefName: "main",
    },
    {
      threadId: "t2",
      kind: "fix",
      title: null,
      status: "missing",
      headRefOid: "old",
      baseRefName: "main",
    },
    {
      threadId: "t1",
      kind: "review",
      title: "Review cli/cli#9000",
      status: "idle",
      headRefOid: "old",
      baseRefName: "main",
    },
  ]);
  expect(activity.latestReview).toBeNull();
  expect(harness.inspection.realtimeSignals).toEqual([
    { channel: "agent-activity", payload: { key: "cli/cli#9000" } },
    { channel: "agent-activity", payload: { key: "cli/cli#9000" } },
    { channel: "agent-activity", payload: { key: "cli/cli#9000" } },
  ]);
});

test("the review shown is the newest that reported, even while a newer one is still at work", async () => {
  const threads: Record<string, { status: string }> = {
    r1: { status: "idle" },
    r2: { status: "idle" },
    r3: { status: "active" },
  };
  const { bb, store } = host(threads);
  await linkThread(bb, store, KEY, {
    threadId: "r1",
    kind: "review",
    headRefOid: "a",
    baseRefName: "main",
  });
  await store.setRun(run("r1", "a"));
  // r2 ended without reporting: the earlier report still stands.
  await linkThread(bb, store, KEY, {
    threadId: "r2",
    kind: "review",
    headRefOid: "b",
    baseRefName: "main",
  });
  expect((await agentActivity(bb, store, KEY)).latestReview).toEqual(run("r1", "a"));

  await linkThread(bb, store, KEY, {
    threadId: "r3",
    kind: "review",
    headRefOid: "c",
    baseRefName: "main",
  });
  // r3 is at work: the thread says so, and r1's report stays the one to show.
  expect((await agentActivity(bb, store, KEY)).latestReview).toEqual(run("r1", "a"));
  expect(await runningReview(bb, store, KEY, { headRefOid: "c", baseRefName: "main" })).toBe("r3");
  expect(await runningReview(bb, store, KEY, { headRefOid: "b", baseRefName: "main" })).toBeNull();

  threads["r3"] = { status: "idle" };
  await store.setRun(run("r3", "c"));
  expect((await agentActivity(bb, store, KEY)).latestReview).toEqual(run("r3", "c"));
  expect(await runningReview(bb, store, KEY, { headRefOid: "c", baseRefName: "main" })).toBeNull();
});

test("a review running against another base is not the review of a retargeted pull request", async () => {
  const { bb, store } = host({ r1: { status: "active" } });
  await linkThread(bb, store, KEY, {
    threadId: "r1",
    kind: "review",
    headRefOid: "c",
    baseRefName: "main",
  });

  expect(await runningReview(bb, store, KEY, { headRefOid: "c", baseRefName: "main" })).toBe("r1");
  expect(
    await runningReview(bb, store, KEY, { headRefOid: "c", baseRefName: "release" }),
  ).toBeNull();
});
