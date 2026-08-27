import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCacheFresh,
  matchPullForBranch,
  needsMergeStateLookup,
  parseRestPull,
  parseRestPulls,
  PR_CACHE_FRESH_MS,
  sidebarPrFromRest,
  sidebarPrFromTitle,
  type CachedPullRow,
  type RestPull,
} from "../lib/pr-index.ts";
import { resolveThreadPullRequests, type ThreadPrQuery } from "../lib/pr-index-run.ts";

const pull = (overrides: Partial<RestPull> = {}): RestPull => ({
  number: 12,
  title: "Dump curl headers",
  url: "https://github.com/acme/app/pull/12",
  draft: false,
  state: "open",
  merged: false,
  headRef: "feat/curl-dump-header",
  mergeableState: "unknown",
  autoMerge: false,
  ...overrides,
});

describe("parseRestPulls", () => {
  it("keeps well-formed pulls and drops junk", () => {
    const parsed = parseRestPulls([
      {
        number: 12,
        title: "Dump curl headers",
        html_url: "https://github.com/acme/app/pull/12",
        state: "open",
        draft: true,
        merged_at: null,
        head: { ref: "feat/curl-dump-header" },
      },
      { number: "nope" },
    ]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.draft, true);
    assert.equal(parsed[0]?.headRef, "feat/curl-dump-header");
  });
});

describe("parseRestPull", () => {
  it("treats merged true and merged_at as merged", () => {
    assert.equal(
      parseRestPull({
        number: 2406,
        title: "Done",
        html_url: "https://github.com/acme/app/pull/2406",
        state: "closed",
        merged: true,
        merged_at: null,
        head: { ref: "feat/done" },
      })?.merged,
      true,
    );
    assert.equal(
      parseRestPull({
        number: 2406,
        title: "Done",
        html_url: "https://github.com/acme/app/pull/2406",
        state: "closed",
        merged_at: "2026-08-26T00:00:00Z",
        head: { ref: "feat/done" },
      })?.merged,
      true,
    );
  });
});

describe("matchPullForBranch", () => {
  it("matches an open PR for the branch and ignores GitButler's workspace ref", () => {
    const pulls = [pull(), pull({ number: 13, headRef: "other", state: "open" })];
    assert.equal(matchPullForBranch(pulls, "feat/curl-dump-header")?.number, 12);
    assert.equal(matchPullForBranch(pulls, "gitbutler/workspace"), null);
    assert.equal(matchPullForBranch(pulls, "3 GitButler branches"), null);
    assert.equal(matchPullForBranch(pulls, null), null);
  });
});

describe("sidebarPrFromRest", () => {
  it("maps draft, merged, and open onto sidebar states", () => {
    assert.equal(sidebarPrFromRest(pull({ draft: true })).state, "draft");
    assert.equal(sidebarPrFromRest(pull({ draft: true })).attention, "draft");
    assert.equal(sidebarPrFromRest(pull({ merged: true, state: "closed" })).state, "merged");
    assert.equal(sidebarPrFromRest(pull()).attention, "none");
  });

  it("maps GitHub mergeable_state onto bb attention", () => {
    assert.equal(sidebarPrFromRest(pull({ mergeableState: "clean" })).attention, "ready_to_merge");
    assert.equal(sidebarPrFromRest(pull({ mergeableState: "dirty" })).attention, "conflicts");
    assert.equal(
      sidebarPrFromRest(pull({ mergeableState: "unstable" })).attention,
      "checks_failed",
    );
    assert.equal(sidebarPrFromRest(pull({ mergeableState: "blocked" })).attention, "blocked");
    assert.equal(sidebarPrFromRest(pull({ autoMerge: true })).attention, "queued");
  });
});

describe("sidebarPrFromTitle", () => {
  it("fills owner/repo from the git remote when the title only has a number", () => {
    const pr = sidebarPrFromTitle("Verify APNs (#2213)", { owner: "acme", repo: "app" });
    assert.equal(pr?.number, 2213);
    assert.equal(pr?.url, "https://github.com/acme/app/pull/2213");
    assert.equal(pr?.source, "title");
  });
});

describe("isCacheFresh", () => {
  it("treats a merged hit as fresh for 15 minutes", () => {
    const row: CachedPullRow = {
      environmentId: "env_1",
      owner: "acme",
      repo: "app",
      number: 12,
      title: "Dump",
      url: "https://github.com/acme/app/pull/12",
      state: "merged",
      attention: "merged",
      fetchedAt: 1_000,
    };
    assert.equal(isCacheFresh(row, 1_000 + PR_CACHE_FRESH_MS - 1), true);
    assert.equal(isCacheFresh(row, 1_000 + PR_CACHE_FRESH_MS), false);
  });

  it("does not trust an open hit, so a merge is visible on the next tick", () => {
    const row: CachedPullRow = {
      environmentId: "env_1",
      owner: "acme",
      repo: "app",
      number: 12,
      title: "Dump",
      url: "https://github.com/acme/app/pull/12",
      state: "open",
      attention: "none",
      fetchedAt: 1_000,
    };
    assert.equal(isCacheFresh(row, 1_001), false);
  });
});

describe("needsMergeStateLookup", () => {
  it("asks for a numbered GET only when the list left the state unknown", () => {
    assert.equal(needsMergeStateLookup(pull()), true);
    assert.equal(needsMergeStateLookup(pull({ mergeableState: "clean" })), false);
    assert.equal(needsMergeStateLookup(pull({ draft: true })), false);
    assert.equal(needsMergeStateLookup(pull({ autoMerge: true })), false);
    assert.equal(needsMergeStateLookup(pull({ state: "closed" })), false);
    assert.equal(needsMergeStateLookup(pull({ merged: true })), false);
  });
});

describe("resolveThreadPullRequests", () => {
  const query = (overrides: Partial<ThreadPrQuery> = {}): ThreadPrQuery => ({
    threadId: "thr_1",
    environmentId: "env_1",
    branchName: "feat/curl-dump-header",
    title: "Dump curl headers",
    ...overrides,
  });

  it("lists each repository once and matches by branch", async () => {
    let restCalls = 0;
    const resolved = await resolveThreadPullRequests(
      [query(), query({ threadId: "thr_2", title: "same repo other thread" })],
      {
        now: 5_000,
        restRemaining: 4_000,
        getCache: () => undefined,
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => {
          restCalls += 1;
          return [pull()];
        },
        getPull: async () => {
          throw new Error("should not look up a numbered PR");
        },
        listRecentClosedPulls: async () => [],
        log: { info() {}, warn() {} },
      },
    );
    assert.equal(restCalls, 1);
    assert.equal(resolved.get("thr_1")?.number, 12);
    assert.equal(resolved.get("thr_1")?.source, "rest");
    assert.equal(resolved.get("thr_2")?.number, 12);
  });

  it("falls back to the title when REST is too tight to spend", async () => {
    const resolved = await resolveThreadPullRequests(
      [query({ title: "acme/app#12 Dump curl headers" })],
      {
        now: 5_000,
        restRemaining: 10,
        getCache: () => undefined,
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => {
          throw new Error("should not hit REST");
        },
        getPull: async () => {
          throw new Error("should not look up a numbered PR");
        },
        listRecentClosedPulls: async () => [],
        log: { info() {}, warn() {} },
      },
    );
    assert.equal(resolved.get("thr_1")?.source, "title");
    assert.equal(resolved.get("thr_1")?.number, 12);
  });

  it("buys the merge state the open list omits, so a blocked PR is not green", async () => {
    // `/repos/.../pulls` has no `mergeable_state`, so every listed open PR
    // arrived as "unknown" -> attention "none" -> the open-PR green. #377 was
    // blocked with failing checks and still read as healthy.
    const lookedUp: number[] = [];
    const resolved = await resolveThreadPullRequests([query()], {
      now: 5_000,
      restRemaining: 4_000,
      getCache: () => undefined,
      putCache: () => {},
      getRepo: async () => ({ owner: "acme", repo: "app" }),
      listOpenPulls: async () => [pull({ mergeableState: "unknown" })],
      getPull: async (_repo, number) => {
        lookedUp.push(number);
        return pull({ number, mergeableState: "blocked" });
      },
      listRecentClosedPulls: async () => [],
      log: { info() {}, warn() {} },
    });
    assert.deepEqual(lookedUp, [12]);
    assert.equal(resolved.get("thr_1")?.attention, "blocked");
  });

  it("keeps the listed pull when the numbered lookup fails", async () => {
    const resolved = await resolveThreadPullRequests([query()], {
      now: 5_000,
      restRemaining: 4_000,
      getCache: () => undefined,
      putCache: () => {},
      getRepo: async () => ({ owner: "acme", repo: "app" }),
      listOpenPulls: async () => [pull()],
      getPull: async () => {
        throw new Error("REST refused");
      },
      listRecentClosedPulls: async () => [],
      log: { info() {}, warn() {} },
    });
    assert.equal(resolved.get("thr_1")?.number, 12);
    assert.equal(resolved.get("thr_1")?.attention, "none");
  });

  it("spends no lookup on states the list already decides", async () => {
    const resolved = await resolveThreadPullRequests(
      [query(), query({ threadId: "thr_2", branchName: "feat/queued" })],
      {
        now: 5_000,
        restRemaining: 4_000,
        getCache: () => undefined,
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => [
          pull({ draft: true }),
          pull({ number: 13, headRef: "feat/queued", autoMerge: true }),
        ],
        getPull: async () => {
          throw new Error("should not look up a numbered PR");
        },
        listRecentClosedPulls: async () => [],
        log: { info() {}, warn() {} },
      },
    );
    assert.equal(resolved.get("thr_1")?.attention, "draft");
    assert.equal(resolved.get("thr_2")?.attention, "queued");
  });

  it("serves a stale cache when REST is skipped and the title has no number", async () => {
    const resolved = await resolveThreadPullRequests([query()], {
      now: 5_000 + PR_CACHE_FRESH_MS + 1,
      restRemaining: 0,
      getCache: () => ({
        environmentId: "env_1",
        owner: "acme",
        repo: "app",
        number: 12,
        title: "Dump curl headers",
        url: "https://github.com/acme/app/pull/12",
        state: "open",
        attention: "none",
        fetchedAt: 5_000,
      }),
      putCache: () => {
        throw new Error("must not refresh TTL from a stale hit");
      },
      getRepo: async () => ({ owner: "acme", repo: "app" }),
      listOpenPulls: async () => {
        throw new Error("should not hit REST");
      },
      getPull: async () => {
        throw new Error("should not look up a numbered PR");
      },
      listRecentClosedPulls: async () => [],
      log: { info() {}, warn() {} },
    });
    assert.equal(resolved.get("thr_1")?.source, "cache");
  });

  it("looks up a titled PR that has left the open list, so a merge turns purple", async () => {
    const resolved = await resolveThreadPullRequests(
      [query({ title: "acme/app#2406 shipped", branchName: "feat/shipped" })],
      {
        now: 5_000,
        restRemaining: 4_000,
        getCache: () => undefined,
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => [],
        getPull: async (_repo, number) =>
          pull({
            number,
            title: "shipped",
            url: "https://github.com/acme/app/pull/2406",
            state: "closed",
            merged: true,
            headRef: "feat/shipped",
          }),
        listRecentClosedPulls: async () => [],
        log: { info() {}, warn() {} },
      },
    );
    assert.equal(resolved.get("thr_1")?.number, 2406);
    assert.equal(resolved.get("thr_1")?.state, "merged");
    assert.equal(resolved.get("thr_1")?.attention, "merged");
    assert.equal(resolved.get("thr_1")?.source, "rest");
  });

  it("does not treat a title #number as an open PR after REST listed the repo", async () => {
    const cached: CachedPullRow[] = [];
    const resolved = await resolveThreadPullRequests([query({ title: "acme/app#2406 shipped" })], {
      now: 5_000,
      restRemaining: 4_000,
      getCache: () => undefined,
      putCache: (row) => {
        cached.push(row);
      },
      getRepo: async () => ({ owner: "acme", repo: "app" }),
      listOpenPulls: async () => [],
      getPull: async () => null,
      listRecentClosedPulls: async () => [],
      log: { info() {}, warn() {} },
    });
    assert.equal(resolved.get("thr_1"), undefined);
    assert.equal(cached.length, 1);
    assert.equal(cached[0]?.number, null);
  });

  it("colours a merged PR from the closed list even when the title cites a parent", async () => {
    const resolved = await resolveThreadPullRequests(
      [
        query({
          title: "docs(webapp): say why curlwright is outside the #2255 flag sweep",
          branchName: "gitbutler/workspace",
        }),
      ],
      {
        now: 5_000,
        restRemaining: 4_000,
        getCache: () => ({
          environmentId: "env_1",
          owner: "acme",
          repo: "app",
          number: 2450,
          title: "docs(webapp): say why curlwright is outside the #2255 flag sweep",
          url: "https://github.com/acme/app/pull/2450",
          state: "open",
          attention: "none",
          fetchedAt: 1_000,
        }),
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => [
          pull({ number: 2255, headRef: "feat/parent", title: "parent" }),
        ],
        listRecentClosedPulls: async () => [
          pull({
            number: 2450,
            title: "docs",
            url: "https://github.com/acme/app/pull/2450",
            state: "closed",
            merged: true,
            headRef: "bb/curlwright-note",
          }),
        ],
        getPull: async () => {
          throw new Error("closed list should match the cached number");
        },
        log: { info() {}, warn() {} },
      },
    );
    assert.equal(resolved.get("thr_1")?.number, 2450);
    assert.equal(resolved.get("thr_1")?.state, "merged");
    assert.equal(resolved.get("thr_1")?.source, "rest");
  });

  it("does not keep a stale open colour after the PR leaves the open list", async () => {
    const resolved = await resolveThreadPullRequests([query({ title: "no number here" })], {
      now: 5_000,
      restRemaining: 4_000,
      getCache: () => ({
        environmentId: "env_1",
        owner: "acme",
        repo: "app",
        number: 2421,
        title: "old",
        url: "https://github.com/acme/app/pull/2421",
        state: "open",
        attention: "none",
        fetchedAt: 1_000,
      }),
      putCache: () => {},
      getRepo: async () => ({ owner: "acme", repo: "app" }),
      listOpenPulls: async () => [],
      listRecentClosedPulls: async () => [],
      getPull: async (_repo, number) =>
        pull({
          number,
          title: "merged now",
          url: "https://github.com/acme/app/pull/2421",
          state: "closed",
          merged: true,
        }),
      log: { info() {}, warn() {} },
    });
    assert.equal(resolved.get("thr_1")?.number, 2421);
    assert.equal(resolved.get("thr_1")?.state, "merged");
  });

  it("looks up owner/repo#N from the title even when the checkout is another repository", async () => {
    const lookups: string[] = [];
    const resolved = await resolveThreadPullRequests(
      [query({ title: "see other/repo#123 for context", branchName: "local-notes" })],
      {
        now: 5_000,
        restRemaining: 4_000,
        getCache: () => undefined,
        putCache: () => {},
        getRepo: async () => ({ owner: "acme", repo: "app" }),
        listOpenPulls: async () => [pull({ number: 99, headRef: "feat/unrelated" })],
        listRecentClosedPulls: async () => [],
        getPull: async (repo, number) => {
          lookups.push(`${repo.owner}/${repo.repo}#${number}`);
          return pull({
            number,
            title: "the cited one",
            url: `https://github.com/${repo.owner}/${repo.repo}/pull/${number}`,
            headRef: "feat/cited",
          });
        },
        log: { info() {}, warn() {} },
      },
    );
    assert.deepEqual(lookups, ["other/repo#123"]);
    assert.equal(resolved.get("thr_1")?.number, 123);
    assert.equal(resolved.get("thr_1")?.url, "https://github.com/other/repo/pull/123");
  });
});
