import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { GhFailure, GraphqlFailure, fakeGh } from "../../../test/fake-gh.ts";
import { createPrWatcher } from "./pr-watch.ts";

const REF = { owner: "acme", repo: "api", number: 7 };

type Run = {
  id: number;
  name: string;
  state: "pending" | "success" | "failure" | "cancelled";
  status?: boolean;
};
type Item = { id: string; login: string };

function checksData(head: string, runs: Run[]) {
  return {
    repository: {
      pullRequest: {
        headRefOid: head,
        commits: {
          nodes: [
            {
              commit: {
                id: `C_${head}`,
                statusCheckRollup: {
                  state: runs.some((run) => run.state === "pending") ? "PENDING" : "SUCCESS",
                  contexts: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: runs.map((run) =>
                      run.status
                        ? {
                            __typename: "StatusContext",
                            context: run.name,
                            state: run.state === "success" ? "SUCCESS" : run.state.toUpperCase(),
                            targetUrl: null,
                            description: null,
                            createdAt: "2026-10-26T12:00:00Z",
                          }
                        : {
                            __typename: "CheckRun",
                            databaseId: run.id,
                            name: run.name,
                            status: run.state === "pending" ? "IN_PROGRESS" : "COMPLETED",
                            conclusion: run.state === "pending" ? null : run.state.toUpperCase(),
                            detailsUrl: `https://github.com/acme/api/actions/runs/1/job/${run.id}`,
                            startedAt: null,
                            completedAt: null,
                            title: null,
                            checkSuite: { app: null, workflowRun: { workflow: { name: "CI" } } },
                          },
                    ),
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

/** A pull request on a fake GitHub, and a bb whose threads report `status`. */
function setup() {
  const pr = {
    state: "OPEN",
    head: "a".repeat(40),
    mergeState: "CLEAN" as string | null,
    runs: [] as Run[],
    comments: [] as Item[],
    reviews: [] as (Item & { state: string; body: string })[],
    threadComments: [] as Item[],
    fail: null as unknown,
    rateRemaining: 5000,
    /** Holds the next PrWatch read until released. */
    hold: null as Promise<void> | null,
  };
  const node = (item: Item) => ({
    id: item.id,
    url: `https://github.com/acme/api/pull/7#${item.id}`,
    author: { login: item.login },
  });
  const fake = fakeGh({
    graphql: {
      PrWatch: async () => {
        if (pr.hold) await pr.hold;
        if (pr.fail) throw pr.fail;
        return {
          rateLimit: { remaining: pr.rateRemaining, resetAt: "2026-10-26T14:00:00.000Z" },
          viewer: { login: "octocat" },
          repository: {
            pullRequest: {
              url: "https://github.com/acme/api/pull/7",
              title: "Rate limit the API",
              state: pr.state,
              baseRefName: "main",
              mergeStateStatus: pr.mergeState,
              comments: { nodes: pr.comments.map(node) },
              reviews: {
                nodes: pr.reviews.map((r) => ({ ...node(r), state: r.state, body: r.body })),
              },
              reviewThreads: {
                nodes: [
                  { path: "src/a.ts", line: 3, comments: { nodes: pr.threadComments.map(node) } },
                ],
              },
            },
          },
        };
      },
      Checks: () => checksData(pr.head, pr.runs),
    },
  });
  const status: Record<string, string> = {};
  const archived = new Set<string>();
  const sent: { threadId: string; mode: string; text: string }[] = [];
  const host = createFakePluginHost({
    pluginId: "code-review",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: (status[threadId] ?? "idle") as never,
            archivedAt: archived.has(threadId) ? Date.parse("2026-10-26T00:00:00.000Z") : null,
          }),
        send: async (args) => {
          const input = args.input[0];
          sent.push({
            threadId: args.threadId,
            mode: args.mode,
            text: input?.type === "text" ? input.text : "",
          });
          return {} as never;
        },
      },
    },
  });
  let clock = Date.parse("2026-10-26T12:00:00.000Z");
  const watcher = createPrWatcher({ bb: host.bb, github: fake.github, now: () => clock });
  const later = (ms: number) => {
    clock += ms;
  };
  const reads = () => fake.operations().filter((operation) => operation === "PrWatch").length;
  return { pr, watcher, status, archived, sent, later, host, reads };
}

test("wakes an idle thread once with what others did, holding news while it works", async () => {
  const { pr, watcher, status, sent, later } = setup();
  pr.runs = [
    { id: 1, name: "build", state: "pending" },
    { id: 2, name: "lint", state: "success" },
  ];
  pr.comments = [{ id: "c-old", login: "alice" }];

  status["thr_a"] = "active";
  expect(await watcher.watch("thr_a", REF)).toStartWith(
    "Watching acme/api#7 (head aaaaaaa: 1 running; merge state CLEAN). End your turn now",
  );
  expect((await watcher.list("thr_a")).map((watch) => watch.checks.checks.length)).toEqual([2]);

  pr.runs[0]!.state = "failure";
  pr.mergeState = "BEHIND";
  pr.comments.push(
    { id: "c-alice", login: "alice" },
    { id: "c-mine", login: "octocat" },
    { id: "c-ci", login: "github-actions[bot]" },
  );
  pr.reviews.push(
    { id: "r-empty", login: "greptile-apps[bot]", state: "COMMENTED", body: "" },
    { id: "r-ok", login: "bob", state: "APPROVED", body: "" },
  );
  pr.threadComments.push({ id: "t-1", login: "greptile-apps[bot]" });
  later(30_000);
  await watcher.poll();
  expect(sent).toEqual([]);

  status["thr_a"] = "idle";
  await watcher.flush("thr_a");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.mode).toBe("queue-if-active");
  expect(sent[0]!.text).toBe(
    [
      "Pull request watch:",
      [
        "acme/api#7 https://github.com/acme/api/pull/7",
        "- Check failed: build https://github.com/acme/api/actions/runs/1/job/1",
        "- All checks finished on aaaaaaa: 1 passed, 1 failed.",
        "- Comment from alice: https://github.com/acme/api/pull/7#c-alice",
        "- Review from bob (approved): https://github.com/acme/api/pull/7#r-ok",
        "- Review comment from greptile-apps[bot] on src/a.ts:3: https://github.com/acme/api/pull/7#t-1",
        "- The branch is behind main.",
      ].join("\n"),
      "The watch continues. Handle what needs action, then end your turn. Before you hand off, call `code_review_watch_pr` with `stop: true`.",
    ].join("\n\n"),
  );

  // Nothing new, nothing sent. A push starts the head's checks over.
  later(60_000);
  await watcher.poll();
  pr.head = "b".repeat(40);
  pr.runs = [{ id: 1, name: "build", state: "pending" }];
  later(60_000);
  await watcher.poll();
  expect(sent).toHaveLength(1);
  pr.runs[0]!.state = "failure";
  later(30_000);
  await watcher.poll();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.text).toContain("- Check failed: build");
  expect(sent[1]!.text).toContain("- All checks finished on bbbbbbb: 1 failed.");

  pr.state = "MERGED";
  later(60_000);
  await watcher.poll();
  expect(sent[2]!.text).toContain("- Merged. The watch ended.");
  expect(sent[2]!.text).toEndWith("Nothing is watched now.");
  expect(await watcher.list("thr_a")).toEqual([]);
});

test("one live thread watches a pull request; watching again keeps it, and stop ends it", async () => {
  const { watcher, archived, host } = setup();
  await watcher.watch("thr_a", REF);
  expect(await watcher.watch("thr_a", { ...REF, owner: "ACME" })).toStartWith(
    "Already watching acme/api#7",
  );
  await expect(watcher.watch("thr_b", REF)).rejects.toThrow("Thread thr_a already watches");
  expect(await watcher.stop("thr_a", REF)).toBe(true);
  expect(await watcher.stop("thr_a", REF)).toBe(false);

  await watcher.watch("thr_b", REF);
  archived.add("thr_b");
  await watcher.watch("thr_c", REF);
  expect(await watcher.list("thr_b")).toEqual([]);
  expect(await watcher.list("thr_c")).toHaveLength(1);
  expect(host.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain(
    "pr-watch",
  );
});

test("backs off failed reads, then stops and says why", async () => {
  const { pr, watcher, sent, later } = setup();
  await watcher.watch("thr_a", REF);
  pr.fail = new GhFailure("gh: HTTP 502: Bad Gateway");
  for (let i = 0; i < 9; i++) {
    later(5 * 60_000);
    await watcher.poll();
  }
  const [watch] = await watcher.list("thr_a");
  expect(watch?.error).toBe("HTTP 502: Bad Gateway");
  expect(watch?.ended).toBe(false);
  expect(sent).toEqual([]);
  later(5 * 60_000);
  await watcher.poll();
  expect(sent[0]!.text).toContain(
    "- Stopped watching after 10 failed reads: HTTP 502: Bad Gateway.",
  );
  expect(await watcher.list("thr_a")).toEqual([]);

  pr.fail = null;
  await watcher.watch("thr_a", REF);
  pr.fail = new GraphqlFailure("NOT_FOUND", "Could not resolve to a PullRequest");
  later(60_000);
  await watcher.poll();
  expect(sent[1]!.text).toContain("Stopped watching: GitHub cannot find the pull request");
});

test("refuses a pull request that is no longer open", async () => {
  const { pr, watcher } = setup();
  pr.state = "CLOSED";
  await expect(watcher.watch("thr_a", REF)).rejects.toThrow("acme/api#7 is closed");
});

test("checks that run again on the same head finish, and fail, as news again", async () => {
  const { pr, watcher, sent, later } = setup();
  pr.runs = [
    { id: 1, name: "build", state: "failure" },
    { id: 2, name: "lint", state: "success" },
    { id: 3, name: "deploy/preview", state: "failure", status: true },
  ];
  await watcher.watch("thr_a", REF);

  // The agent re-runs the flaky job and its status; both pass.
  pr.runs = [
    { id: 4, name: "build", state: "pending" },
    { id: 2, name: "lint", state: "success" },
    { id: 3, name: "deploy/preview", state: "pending", status: true },
  ];
  later(60_000);
  await watcher.poll();
  expect(sent).toEqual([]);
  pr.runs[0]!.state = "success";
  pr.runs[2]!.state = "success";
  later(30_000);
  await watcher.poll();
  expect(sent[0]!.text).toContain("- All checks finished on aaaaaaa: 3 passed.");

  // A check that registers late runs, then fails; the status fails a second time.
  pr.runs.push({ id: 5, name: "vercel", state: "pending" });
  pr.runs[2]!.state = "pending";
  later(60_000);
  await watcher.poll();
  pr.runs[3]!.state = "failure";
  pr.runs[2]!.state = "failure";
  later(30_000);
  await watcher.poll();
  expect(sent[1]!.text).toContain("- Check failed: deploy/preview");
  expect(sent[1]!.text).toContain("- Check failed: vercel");
  expect(sent[1]!.text).toContain("- All checks finished on aaaaaaa: 2 passed, 2 failed.");
});

test("a used-up rate limit pauses the watch instead of ending it", async () => {
  const { pr, watcher, sent, later, reads } = setup();
  await watcher.watch("thr_a", REF);
  pr.fail = new GhFailure("gh: API rate limit exceeded for user ID 1. (HTTP 403)");
  for (let i = 0; i < 12; i++) {
    later(5 * 60_000);
    await watcher.poll();
  }
  const [watch] = await watcher.list("thr_a");
  expect(watch?.ended).toBe(false);
  expect(watch?.error).toContain("rate limit");
  expect(sent).toEqual([]);

  // Running low at 13:05, it waits for the reset at 14:00 before reading again.
  pr.fail = null;
  pr.rateRemaining = 100;
  later(5 * 60_000);
  await watcher.poll();
  const before = reads();
  later(10 * 60_000);
  await watcher.poll();
  expect(reads()).toBe(before);
});

test("two threads that start the same watch at once get one owner", async () => {
  const { pr, watcher } = setup();
  let release = () => {};
  pr.hold = new Promise((resolve) => {
    release = resolve;
  });
  const starts = Promise.allSettled([watcher.watch("thr_a", REF), watcher.watch("thr_b", REF)]);
  release();
  pr.hold = null;
  const [a, b] = await starts;
  expect(a.status).toBe("fulfilled");
  expect(b.status === "rejected" && String(b.reason)).toContain("Thread thr_a already watches");
  expect(await watcher.list("thr_b")).toEqual([]);
});

test("a read that lands after its watch stopped and started again is dropped", async () => {
  const { pr, watcher, later, sent } = setup();
  await watcher.watch("thr_a", REF);
  let release = () => {};
  pr.hold = new Promise((resolve) => {
    release = resolve;
  });
  pr.fail = new GraphqlFailure("NOT_FOUND", "Could not resolve to a PullRequest");
  later(60_000);
  const stale = watcher.poll();
  await Bun.sleep(0);
  await watcher.stop("thr_a", REF);
  pr.hold = null;
  pr.fail = null;
  await watcher.watch("thr_a", REF);
  pr.fail = new GraphqlFailure("NOT_FOUND", "Could not resolve to a PullRequest");
  release();
  await stale;
  pr.fail = null;
  const [watch] = await watcher.list("thr_a");
  expect(watch?.ended).toBe(false);
  expect(watch?.error).toBeNull();
  expect(sent).toEqual([]);
});

test("a thread archived while the plugin did not hear it loses its watches without a read", async () => {
  const { watcher, archived, later, reads } = setup();
  await watcher.watch("thr_a", REF);
  archived.add("thr_a");
  const before = reads();
  later(60_000);
  await watcher.poll();
  expect(reads()).toBe(before);
  expect(await watcher.list("thr_a")).toEqual([]);
});

test("a read that changes nothing the card shows publishes nothing", async () => {
  const { watcher, later, host } = setup();
  await watcher.watch("thr_a", REF);
  const signals = () => host.harness.inspection.realtimeSignals.length;
  const before = signals();
  later(60_000);
  await watcher.poll();
  expect(signals()).toBe(before);
});

test("a slow read holds up only its own pull request, not the reads after it", async () => {
  const read: number[] = [];
  let holding = false;
  let release = () => {};
  const fake = fakeGh({
    graphql: {
      PrWatch: async (variables) => {
        const number = Number(variables["number"]);
        read.push(number);
        if (holding && number === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return {
          rateLimit: { remaining: 5000, resetAt: "2026-10-26T14:00:00.000Z" },
          viewer: { login: "octocat" },
          repository: {
            pullRequest: {
              url: `https://github.com/acme/api/pull/${number}`,
              title: `Change ${number}`,
              state: "OPEN",
              baseRefName: "main",
              mergeStateStatus: "CLEAN",
              comments: { nodes: [] },
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] },
            },
          },
        };
      },
      Checks: () => checksData("a".repeat(40), []),
    },
  });
  const host = createFakePluginHost({
    pluginId: "code-review",
    sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }) } },
  });
  let clock = Date.parse("2026-10-26T12:00:00.000Z");
  const watcher = createPrWatcher({ bb: host.bb, github: fake.github, now: () => clock });
  for (const number of [1, 2, 3, 4, 5]) await watcher.watch("thr_a", { ...REF, number });
  holding = true;
  read.length = 0;
  clock += 60_000;

  const polling = watcher.poll();
  for (let i = 0; i < 300 && !read.includes(5); i++) await Bun.sleep(10);
  const readWhileHeld = [...read];
  release();
  await polling;

  expect(readWhileHeld.toSorted()).toEqual([1, 2, 3, 4, 5]);
});
