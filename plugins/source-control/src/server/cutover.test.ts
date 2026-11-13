import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { WatchRead } from "../core/watch.ts";
import { createCutover, legacyBranchId } from "./cutover.ts";
import { createLanded } from "./landed.ts";
import { baseline, createPrWatcher, failed, observe, wakeMessage } from "./pr-watch.ts";
import { openStore } from "./store.ts";

const REF = { owner: "acme", repo: "api", number: 42 };
const READ: WatchRead = {
  url: "https://github.com/acme/api/pull/42",
  title: "Route gh",
  state: "open",
  baseRefName: "main",
  mergeState: "CLEAN",
  checks: {
    headRefOid: "c0ffee1",
    checks: [{ id: "run:1", name: "ci", state: "pending", detailsUrl: null }],
  },
  activity: [],
  pausedUntil: null,
};

/** What code-review's export answers: one of each kind, plus records the import must skip. */
function exported() {
  const watch = {
    ...baseline("thr_a", REF, "scott", READ, 1_000),
    checks: { ...READ.checks, state: null },
  };
  return {
    version: 1,
    pins: [REF, { owner: "acme", repo: "web", number: 7, account: "scott" }, { nonsense: true }],
    instructions: "  Flag every new dependency.  ",
    reviewed: [
      {
        branchId: "aaaaaaaaaaaa",
        value: [{ base: "abc1", head: "def2", paths: ["a.ts", "b.ts"] }],
        location: null,
      },
      {
        branchId: "bbbbbbbbbbbb",
        value: [{ base: "abc1", head: "def2", paths: ["c.ts"] }],
        location: { hostId: "host-a", path: "/repo" },
      },
    ],
    watches: [
      { key: "watch:thr_a:acme/api#42", value: watch },
      { key: "watch:thr_b:acme/api#9", value: { ...watch, threadId: "thr_b", ended: true } },
    ],
    landed: [
      {
        threadId: "thr_a",
        value: { target: { account: "scott", prs: [REF], commits: [] }, since: 1_000 },
      },
    ],
    counts: { runs: 3, links: 2, threads: 3 },
  };
}

function setup(answers: Record<string, unknown>, initialInstructions = "") {
  const calls: string[] = [];
  const { bb } = createFakePluginHost({
    pluginId: "source-control",
    sdk: {
      plugins: {
        callRpc: (async ({
          pluginId,
        }: {
          pluginId: string;
          outputSchema: { parse(v: unknown): unknown };
        }) => {
          calls.push(pluginId);
          if (!(pluginId in answers)) throw new Error(`${pluginId} is not running`);
          return answers[pluginId];
        }) as never,
      },
    },
  });
  const store = openStore(bb);
  const watcher = createPrWatcher({
    bb,
    store,
    now: () => 2_000,
    standingDown: () => false,
    read: async () => ({ ok: true, login: "scott", value: READ }),
  });
  const landed = createLanded({
    bb,
    store,
    watcher,
    now: () => 2_000,
    standingDown: () => false,
    lastReply: async () => null,
    read: async () => ({ ok: false, reason: "away", message: "away" }),
  });
  let text = initialInstructions;
  const cutover = createCutover({
    bb,
    store,
    host: { range: async () => ({ ok: true, value: { kind: "files", files: [] } }) } as never,
    watcher,
    landed,
    instructions: { get: async () => text, set: async (next) => void (text = next) },
    now: () => 2_000,
  });
  return { cutover, store, watcher, calls, instructions: () => text };
}

test("the import reads each kind once, is idempotent by natural key, and never writes to the old plugins", async () => {
  const world = setup({
    "code-review": exported(),
    gitbutler: {
      version: 1,
      records: [
        { kind: "threadBranches", key: "thread-branch-v3:thr_a", value: {} },
        { kind: "reviewRequests", key: "review-requests:h:/p", value: [] },
      ],
    },
  });
  const first = await world.cutover.run();
  expect(first.unavailable).toEqual([]);
  expect(first.counts.pins).toEqual({
    read: 3,
    imported: 2,
    present: 0,
    skipped: { "not a pull request reference": 1 },
  });
  expect(first.counts.reviewInstructions).toEqual({
    read: 1,
    imported: 1,
    present: 0,
    skipped: {},
  });
  expect(world.instructions()).toBe("Flag every new dependency.");
  // One branch never recorded where it was; the other's checkout Source Control has not read.
  expect(first.counts.viewedMarks).toEqual({
    read: 3,
    imported: 0,
    present: 0,
    skipped: { "branch location unknown": 2, "branch not found": 1 },
  });
  expect(first.counts.prWatches).toEqual({
    read: 2,
    imported: 1,
    present: 0,
    skipped: { "already ended": 1 },
  });
  expect(world.watcher.list("thr_a").map((watch) => watch.checks.headRefOid)).toEqual(["c0ffee1"]);
  expect(first.counts.landed).toEqual({ read: 1, imported: 1, present: 0, skipped: {} });
  expect(first.counts.reviewRuns?.skipped).toEqual({ "stay readable in their review threads": 3 });
  expect(first.counts.threadBranches?.skipped).toEqual({
    "re-read from thread history by Source Control": 1,
  });

  const second = await world.cutover.run();
  expect(second.counts.pins).toMatchObject({ imported: 0, present: 2 });
  expect(second.counts.reviewInstructions).toMatchObject({ imported: 0, present: 1 });
  expect(second.counts.prWatches).toMatchObject({ imported: 0, present: 1 });
  expect(second.counts.landed).toMatchObject({ imported: 0, present: 1 });
  // Only the read-only exports were called.
  expect(new Set(world.calls)).toEqual(new Set(["code-review", "gitbutler"]));
});

test("an old plugin that is not running is reported, and the other one still imports", async () => {
  const world = setup({ "code-review": exported() });
  const report = await world.cutover.run();
  expect(report.unavailable).toEqual([{ plugin: "gitbutler", reason: "gitbutler is not running" }]);
  expect(report.counts.pins?.imported).toBe(2);
});

test("instructions Source Control already has are kept, and the old ones are skipped with the reason", async () => {
  const world = setup({ "code-review": exported() }, "Check the migrations.");
  const report = await world.cutover.run();
  expect(report.counts.reviewInstructions).toEqual({
    read: 1,
    imported: 0,
    present: 0,
    skipped: { "Source Control already has different instructions": 1 },
  });
  expect(world.instructions()).toBe("Check the migrations.");
});

test("an old branch id is code-review's: sha256 of host, path and branch, 12 hex", () => {
  expect(legacyBranchId("host-a", "/repo", "scott/x")).toMatch(/^[0-9a-f]{12}$/);
  expect(legacyBranchId("host-a", "/repo", "scott/x")).not.toBe(
    legacyBranchId("host-a", "/repo", "scott/y"),
  );
});

test("a watch waits while its site is away, and ends when GitHub cannot find the pull request", () => {
  const record = baseline("thr_a", REF, "scott", READ, 0);
  const away = failed(record, { ok: false, reason: "away", message: "studio-mac is asleep" }, 10);
  expect(away).toMatchObject({ ended: false, failures: 0, pending: [] });
  const gone = failed(record, { ok: false, reason: "gone", message: "Not Found" }, 10);
  expect(gone.ended).toBe(true);
  expect(gone.pending).toEqual([
    "Stopped watching: GitHub cannot find the pull request (Not Found).",
  ]);
});

test("finished checks and a failure are news once; the wake names the stop call", () => {
  const record = baseline("thr_a", REF, "scott", READ, 0);
  const done = observe(
    record,
    {
      ...READ,
      checks: {
        headRefOid: "c0ffee1",
        checks: [{ id: "run:1", name: "ci", state: "failure", detailsUrl: null }],
      },
    },
    10,
  );
  expect(done.pending).toEqual(["Check failed: ci", "All checks finished on c0ffee1: 1 failed."]);
  expect(observe(done, { ...READ, checks: done.checks }, 20).pending).toEqual(done.pending);
  expect(wakeMessage([done])).toContain("call `source_control_watch_pr` with `stop: true`");
});
