import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pollSnoozedPullRequests,
  type PrWatchPollStore,
  type StoredPrWatch,
} from "../lib/pr-watch-run.ts";
import {
  MAX_PR_BACKFILL_PER_TICK,
  serializeSnapshot,
  type PrWatchSnapshot,
} from "../lib/pr-watch.ts";

const now = Date.parse("2026-08-26T10:00:00Z");

const snapshot = (overrides: Partial<PrWatchSnapshot> = {}): PrWatchSnapshot => ({
  nodeId: "PR_kw1",
  url: "https://github.com/acme/app/pull/12",
  number: 12,
  title: "Fix the flaky test",
  updatedAt: "2026-08-26T09:00:00Z",
  commentCount: 1,
  reviewCount: 0,
  reviewThreadCount: 0,
  latestReviewState: null,
  latestReviewAuthor: null,
  checkRollup: "SUCCESS",
  latestDeployment: null,
  ...overrides,
});

function graphqlPayload(pr: PrWatchSnapshot, remaining = 4_000) {
  return {
    data: {
      rateLimit: {
        cost: 8,
        remaining,
        resetAt: "2026-08-26T11:00:00Z",
        limit: 5_000,
      },
      p0: {
        id: pr.nodeId,
        url: pr.url,
        number: pr.number,
        title: pr.title,
        updatedAt: pr.updatedAt,
        comments: { totalCount: pr.commentCount },
        reviews: { totalCount: pr.reviewCount },
        reviewThreads: { totalCount: pr.reviewThreadCount },
        latestReviews: {
          nodes:
            pr.latestReviewState === null
              ? []
              : [{ state: pr.latestReviewState, author: { login: pr.latestReviewAuthor } }],
        },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: pr.checkRollup === null ? null : { state: pr.checkRollup },
                deployments: { nodes: pr.latestDeployment === null ? [] : [pr.latestDeployment] },
              },
            },
          ],
        },
      },
    },
  };
}

function memoryStore(
  snoozed: { threadId: string; snoozedUntil: number }[],
  watches: StoredPrWatch[] = [],
): PrWatchPollStore & { watches: Map<string, StoredPrWatch> } {
  const watchMap = new Map(watches.map((watch) => [watch.threadId, watch]));
  return {
    watches: watchMap,
    listSnoozed: () => snoozed,
    getWatch: (threadId) => watchMap.get(threadId),
    upsertWatch(row) {
      watchMap.set(row.threadId, {
        threadId: row.threadId,
        prUrl: row.prUrl,
        snapshotJson: row.snapshotJson,
      });
    },
  };
}

describe("pollSnoozedPullRequests", () => {
  it("baselines the first observation instead of waking", async () => {
    const store = memoryStore(
      [{ threadId: "thr_1", snoozedUntil: now + 60_000 }],
      [{ threadId: "thr_1", prUrl: "https://github.com/acme/app/pull/12", snapshotJson: null }],
    );
    const woken: string[] = [];
    const result = await pollSnoozedPullRequests({
      now,
      store,
      graphql: async () => ({ raw: graphqlPayload(snapshot()), stderr: "", exitCode: 0 }),
      resolvePrUrl: async () => null,
      wakeThread: async (threadId) => {
        woken.push(threadId);
      },
      log: { info() {}, warn() {} },
      remainingHint: null,
      skipUntilMs: null,
    });
    assert.equal(result.baselined, 1);
    assert.equal(result.woken, 0);
    assert.deepEqual(woken, []);
    assert.ok(store.getWatch("thr_1")?.snapshotJson);
  });

  it("wakes when comments or checks change", async () => {
    const previous = snapshot();
    const store = memoryStore(
      [{ threadId: "thr_1", snoozedUntil: now + 60_000 }],
      [
        {
          threadId: "thr_1",
          prUrl: "https://github.com/acme/app/pull/12",
          snapshotJson: serializeSnapshot(previous),
        },
      ],
    );
    const woken: { threadId: string; text: string[] }[] = [];
    const result = await pollSnoozedPullRequests({
      now,
      store,
      graphql: async () => ({
        raw: graphqlPayload(
          snapshot({
            updatedAt: "2026-08-26T10:00:00Z",
            commentCount: 4,
            checkRollup: "FAILURE",
          }),
        ),
        stderr: "",
        exitCode: 0,
      }),
      resolvePrUrl: async () => null,
      wakeThread: async (threadId, _snapshot, changes) => {
        woken.push({ threadId, text: changes.map((change) => change.text) });
      },
      log: { info() {}, warn() {} },
      remainingHint: null,
      skipUntilMs: null,
    });
    assert.equal(result.woken, 1);
    assert.equal(woken[0]?.threadId, "thr_1");
    assert.ok(woken[0]?.text.some((text) => text.includes("new comment")));
    assert.ok(woken[0]?.text.some((text) => text.includes("FAILURE")));
  });

  it("skips the tick when remaining points are too low", async () => {
    let queried = false;
    const result = await pollSnoozedPullRequests({
      now,
      store: memoryStore([{ threadId: "thr_1", snoozedUntil: now + 60_000 }]),
      graphql: async () => {
        queried = true;
        return { raw: {}, stderr: "", exitCode: 0 };
      },
      resolvePrUrl: async () => {
        throw new Error("should not backfill while rate-limited");
      },
      wakeThread: async () => {
        throw new Error("should not wake");
      },
      log: { info() {}, warn() {} },
      remainingHint: 10,
      skipUntilMs: null,
    });
    assert.equal(queried, false);
    assert.equal(result.queried, 0);
  });

  it("caps PR backfill so a cold shelf cannot burst the REST rate limit", async () => {
    const snoozed = Array.from({ length: MAX_PR_BACKFILL_PER_TICK + 5 }, (_, i) => ({
      threadId: `thr_${i}`,
      snoozedUntil: now + 60_000,
    }));
    const store = memoryStore(snoozed);
    let resolved = 0;
    await pollSnoozedPullRequests({
      now,
      store,
      graphql: async () => ({
        raw: {
          data: {
            rateLimit: { cost: 1, remaining: 4000, resetAt: "2026-08-26T11:00:00Z", limit: 5000 },
          },
        },
        stderr: "",
        exitCode: 0,
      }),
      resolvePrUrl: async () => {
        resolved += 1;
        return `https://github.com/acme/app/pull/${resolved}`;
      },
      wakeThread: async () => {},
      log: { info() {}, warn() {} },
      remainingHint: null,
      skipUntilMs: null,
    });
    assert.equal(resolved, MAX_PR_BACKFILL_PER_TICK);
  });

  it("issues a single GraphQL query for every watched URL", async () => {
    const store = memoryStore(
      [
        { threadId: "thr_1", snoozedUntil: now + 60_000 },
        { threadId: "thr_2", snoozedUntil: now + 60_000 },
      ],
      [
        { threadId: "thr_1", prUrl: "https://github.com/acme/app/pull/12", snapshotJson: null },
        { threadId: "thr_2", prUrl: "https://github.com/acme/app/pull/13", snapshotJson: null },
      ],
    );
    const queries: string[] = [];
    await pollSnoozedPullRequests({
      now,
      store,
      graphql: async (query) => {
        queries.push(query);
        return { raw: graphqlPayload(snapshot()), stderr: "", exitCode: 0 };
      },
      resolvePrUrl: async () => null,
      wakeThread: async () => {},
      log: { info() {}, warn() {} },
      remainingHint: null,
      skipUntilMs: null,
    });
    assert.equal(queries.length, 1);
    assert.match(queries[0] ?? "", /p0: resource/);
    assert.match(queries[0] ?? "", /p1: resource/);
    assert.equal([...(queries[0] ?? "").matchAll(/^query /gm)].length, 1);
  });
});
