import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSnoozedPrWatchQuery,
  canonicalPullRequestUrl,
  diffSnapshots,
  fingerprintOf,
  formatAgentWakeMessage,
  parseStoredSnapshot,
  serializeSnapshot,
  isGraphqlRateLimited,
  MAX_WATCHED_PRS,
  MIN_RATE_LIMIT_REMAINING,
  parseSnoozedPrWatchResponse,
  shouldSkipForRateLimit,
  skipUntilMsFromResetAt,
  watchedUrlsForQuery,
  type PrWatchSnapshot,
} from "../lib/pr-watch.ts";

const snapshot = (overrides: Partial<PrWatchSnapshot> = {}): PrWatchSnapshot => ({
  nodeId: "PR_kw1",
  url: "https://github.com/acme/app/pull/12",
  number: 12,
  title: "Fix the flaky test",
  updatedAt: "2026-08-26T10:00:00Z",
  commentCount: 1,
  reviewCount: 0,
  reviewThreadCount: 0,
  latestReviewState: null,
  latestReviewAuthor: null,
  checkRollup: "SUCCESS",
  latestDeployment: null,
  ...overrides,
});

describe("canonicalPullRequestUrl", () => {
  it("strips tab paths and query strings", () => {
    assert.equal(
      canonicalPullRequestUrl("https://github.com/acme/app/pull/12/files?w=1"),
      "https://github.com/acme/app/pull/12",
    );
  });

  it("rejects non-github and non-PR URLs", () => {
    assert.equal(canonicalPullRequestUrl("https://gitlab.com/acme/app/pull/12"), null);
    assert.equal(canonicalPullRequestUrl("https://github.com/acme/app/issues/12"), null);
  });
});

describe("watchedUrlsForQuery", () => {
  it("dedupes, canonicalises, and caps", () => {
    const urls = [
      "https://github.com/acme/app/pull/12/files",
      "https://github.com/acme/app/pull/12",
      "https://example.com/not-a-pr",
      ...Array.from(
        { length: MAX_WATCHED_PRS },
        (_, i) => `https://github.com/acme/app/pull/${i + 1}`,
      ),
    ];
    const watched = watchedUrlsForQuery(urls);
    assert.equal(watched.length, MAX_WATCHED_PRS);
    assert.equal(watched[0], "https://github.com/acme/app/pull/12");
    assert.equal(new Set(watched).size, watched.length);
  });
});

describe("buildSnoozedPrWatchQuery", () => {
  it("is one query with a shared fragment and a rateLimit field", () => {
    const query = buildSnoozedPrWatchQuery([
      "https://github.com/acme/app/pull/12",
      "https://github.com/acme/app/pull/13",
    ]);
    assert.match(query, /^query GtdSnoozedPrWatch \{/);
    assert.equal([...query.matchAll(/^query /gm)].length, 1);
    assert.match(query, /rateLimit \{ cost remaining resetAt limit \}/);
    assert.match(query, /p0: resource\(url: "https:\/\/github\.com\/acme\/app\/pull\/12"\)/);
    assert.match(query, /p1: resource\(url: "https:\/\/github\.com\/acme\/app\/pull\/13"\)/);
    assert.match(query, /fragment PrWatchFields on PullRequest/);
    assert.match(query, /statusCheckRollup \{ state \}/);
    assert.match(query, /deployments\(last: 3\)/);
  });
});

describe("parseSnoozedPrWatchResponse", () => {
  it("reads aliased PRs and the rate limit", () => {
    const parsed = parseSnoozedPrWatchResponse({
      data: {
        rateLimit: {
          cost: 12,
          remaining: 4800,
          resetAt: "2026-08-26T12:00:00Z",
          limit: 5000,
        },
        p0: {
          id: "PR_kw1",
          url: "https://github.com/acme/app/pull/12",
          number: 12,
          title: "Fix the flaky test",
          updatedAt: "2026-08-26T10:00:00Z",
          comments: { totalCount: 3 },
          reviews: { totalCount: 1 },
          reviewThreads: { totalCount: 2 },
          latestReviews: {
            nodes: [{ state: "CHANGES_REQUESTED", author: { login: "riley" } }],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: { state: "FAILURE" },
                  deployments: {
                    nodes: [
                      {
                        createdAt: "2026-08-26T09:00:00Z",
                        state: "PENDING",
                        environment: "staging",
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
        p1: null,
      },
    });
    assert.equal(parsed.rateLimit?.remaining, 4800);
    assert.equal(parsed.snapshots.length, 1);
    assert.deepEqual(parsed.snapshots[0], {
      nodeId: "PR_kw1",
      url: "https://github.com/acme/app/pull/12",
      number: 12,
      title: "Fix the flaky test",
      updatedAt: "2026-08-26T10:00:00Z",
      commentCount: 3,
      reviewCount: 1,
      reviewThreadCount: 2,
      latestReviewState: "CHANGES_REQUESTED",
      latestReviewAuthor: "riley",
      checkRollup: "FAILURE",
      latestDeployment: {
        createdAt: "2026-08-26T09:00:00Z",
        state: "PENDING",
        environment: "staging",
      },
    });
  });
});

describe("diffSnapshots", () => {
  it("reports new comments, reviews, checks, and deployments", () => {
    const previous = snapshot();
    const next = snapshot({
      updatedAt: "2026-08-26T11:00:00Z",
      commentCount: 3,
      reviewCount: 1,
      latestReviewState: "APPROVED",
      latestReviewAuthor: "riley",
      checkRollup: "FAILURE",
      latestDeployment: {
        createdAt: "2026-08-26T10:30:00Z",
        state: "ACTIVE",
        environment: "production",
      },
    });
    const kinds = diffSnapshots(previous, next).map((change) => change.kind);
    assert.deepEqual(kinds, ["comments", "reviews", "checks", "deployments"]);
  });

  it("does not wake on an identical fingerprint", () => {
    const row = snapshot();
    assert.deepEqual(diffSnapshots(row, { ...row }), []);
    assert.equal(fingerprintOf(row), fingerprintOf({ ...row }));
  });

  it("round-trips a stored snapshot", () => {
    const row = snapshot({
      latestReviewState: "APPROVED",
      latestReviewAuthor: "riley",
      latestDeployment: {
        createdAt: "2026-08-26T09:00:00Z",
        state: "ACTIVE",
        environment: "production",
      },
    });
    assert.deepEqual(parseStoredSnapshot(serializeSnapshot(row)), row);
    assert.equal(parseStoredSnapshot("not json"), null);
  });

  it("falls back to a generic update when only updatedAt moved", () => {
    const changes = diffSnapshots(snapshot(), snapshot({ updatedAt: "2026-08-26T11:00:00Z" }));
    assert.deepEqual(changes, [{ kind: "updated", text: "PR updated on GitHub" }]);
  });
});

describe("formatAgentWakeMessage", () => {
  it("names the PR and lists the changes", () => {
    const message = formatAgentWakeMessage(snapshot(), [
      { kind: "comments", text: "2 new comments" },
      { kind: "checks", text: "checks SUCCESS → FAILURE" },
    ]);
    assert.match(message, /#12/);
    assert.match(message, /Fix the flaky test/);
    assert.match(message, /2 new comments/);
    assert.match(message, /checks SUCCESS → FAILURE/);
    assert.match(message, /inspect the pull request/);
  });
});

describe("shouldSkipForRateLimit", () => {
  it("skips while remaining is below the floor or a reset is in the future", () => {
    assert.equal(shouldSkipForRateLimit(null, null, 1_000), false);
    assert.equal(shouldSkipForRateLimit(MIN_RATE_LIMIT_REMAINING, null, 1_000), false);
    assert.equal(shouldSkipForRateLimit(MIN_RATE_LIMIT_REMAINING - 1, null, 1_000), true);
    assert.equal(shouldSkipForRateLimit(5_000, 2_000, 1_000), true);
    assert.equal(shouldSkipForRateLimit(5_000, 2_000, 2_000), false);
  });

  it("waits until GitHub's resetAt, not a guessed hour", () => {
    const now = Date.parse("2026-08-26T10:00:00Z");
    const resetAt = "2026-08-26T10:45:00Z";
    assert.equal(skipUntilMsFromResetAt(resetAt, now), Date.parse(resetAt));
  });
});

describe("isGraphqlRateLimited", () => {
  it("recognises primary and secondary limit wording", () => {
    assert.equal(isGraphqlRateLimited({ errors: [{ type: "RATE_LIMITED" }] }, ""), true);
    assert.equal(isGraphqlRateLimited(null, "You have exceeded a secondary rate limit"), true);
    assert.equal(isGraphqlRateLimited({ data: {} }, ""), false);
  });
});
