import { Effect } from "effect";
import { expect, onTestFinished, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { succeeded, type Problem, type PullRequest } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { FORGE_BACKOFF_MS } from "./forge-read.ts";
import { ForgeUnavailable, type ForgeSites } from "./forge-sites.ts";
import { CONVERSATION_FRESH_MS, createReviewItems, type ReviewItemsDeps } from "./review-items.ts";
import { openStore } from "./store.ts";

const KEY = "gh:acme/api:scott:feature" as ChangeKey;
const PR: PullRequest = {
  number: 42,
  url: "https://github.com/acme/api/pull/42",
  title: "Route gh",
  state: "open",
  isDraft: false,
  headRefOid: "c0ffee",
  baseRef: "main",
  reviewDecision: null,
  approvals: 0,
  mergeable: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  checks: { passed: 0, failed: 0, pending: 0 },
};
const RATE_LIMITED: Problem = {
  kind: "rate-limited",
  site: "the bb server",
  detail: "API rate limit already exceeded for user ID 1.",
};

const timeline = (body: string) => ({
  kind: "timeline" as const,
  description: { author: { login: "scott", avatarUrl: null }, body, createdAt: "", url: PR.url },
  items: [],
});

/** Review items whose GitHub answers each conversation read with the next of `answers`. */
function setup(answers: (string | Problem)[]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "source-control" });
  // Disposing removes the fake host's storage dir.
  onTestFinished(() => harness.lifecycle.dispose());
  const store = openStore(bb);
  store.setForge(KEY, succeeded(PR, 0));
  let now = 1_000;
  let reads = 0;
  const sites = {
    repoRead: () =>
      Effect.suspend(() => {
        const answer = answers[reads++];
        if (answer === undefined) throw new Error("GitHub was asked once more than expected.");
        return typeof answer === "string"
          ? Effect.succeed(timeline(answer))
          : Effect.fail(new ForgeUnavailable({ problem: answer }));
      }),
  } as unknown as ForgeSites;
  const items = createReviewItems({
    store,
    sites,
    share: (_key: string, work: Effect.Effect<unknown, unknown>) => work,
    placementsFor: () => [],
    now: () => now,
  } as unknown as ReviewItemsDeps);
  return {
    store,
    read: () => Effect.runPromise(items.conversation(KEY)),
    advance: (ms: number) => (now += ms),
    reads: () => reads,
  };
}

test("a fresh conversation answers again without asking GitHub", async () => {
  const change = setup(["First"]);
  expect(await change.read()).toMatchObject({
    ok: true,
    stale: null,
    description: { body: "First" },
  });
  change.advance(CONVERSATION_FRESH_MS - 1);
  expect(await change.read()).toMatchObject({ ok: true, description: { body: "First" } });
  expect(change.reads()).toBe(1);
});

test("a new head reads the conversation again", async () => {
  const change = setup(["First", "Second"]);
  await change.read();
  change.store.setForge(KEY, succeeded({ ...PR, headRefOid: "beef" }, 1));
  expect(await change.read()).toMatchObject({ description: { body: "Second" } });
});

test("a refused read keeps the last description, marked stale", async () => {
  const change = setup(["First", RATE_LIMITED]);
  await change.read();
  change.advance(CONVERSATION_FRESH_MS);
  expect(await change.read()).toEqual(
    expect.objectContaining({
      ok: true,
      readAt: 1_000,
      stale: RATE_LIMITED,
      description: expect.objectContaining({ body: "First" }),
    }),
  );
});

test("after a rate limit, GitHub is not asked again until the backoff passes", async () => {
  const change = setup([RATE_LIMITED, "Later"]);
  expect(await change.read()).toEqual({ ok: false, problem: RATE_LIMITED });
  change.advance(FORGE_BACKOFF_MS - 1);
  expect(await change.read()).toEqual({ ok: false, problem: RATE_LIMITED });
  expect(change.reads()).toBe(1);
  change.advance(1);
  expect(await change.read()).toMatchObject({ ok: true, description: { body: "Later" } });
});
