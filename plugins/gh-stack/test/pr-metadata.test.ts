import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPrMetadataReads,
  evictAbsentPrMetadata,
  lifecycleOf,
  partitionPrMetadata,
  stackPrStateSchema,
  type GithubPrState,
  type PrMetadata,
  type PrMetadataCache,
} from "../lib/pr-metadata.ts";

const row = { isMerged: false, isQueued: false };
const github = (state: GithubPrState, isDraft = false) => ({ state, isDraft });

test("the lifecycle folds gh-stack's row with GitHub's read, GitHub owning the terminal states", () => {
  assert.equal(lifecycleOf(row, { state: "OPEN" }, null), "open");
  assert.equal(lifecycleOf(row, { state: "OPEN" }, github("OPEN", true)), "draft");
  // gh-stack's queue flag survives while GitHub still calls the PR open, and
  // outranks the draft flag.
  assert.equal(
    lifecycleOf({ ...row, isQueued: true }, { state: "OPEN" }, github("OPEN", true)),
    "queued",
  );
  assert.equal(lifecycleOf(row, { state: "QUEUED" }, null), "queued");
  // GitHub's terminal states correct a stale OPEN; a draft flag cannot reopen them.
  assert.equal(lifecycleOf(row, { state: "OPEN" }, github("CLOSED", true)), "closed");
  assert.equal(lifecycleOf(row, { state: "OPEN" }, github("MERGED")), "merged");
  // Either source saying merged wins, even over GitHub still reading OPEN.
  assert.equal(
    lifecycleOf({ ...row, isMerged: true }, { state: "OPEN" }, github("OPEN")),
    "merged",
  );
  assert.equal(lifecycleOf(row, { state: "MERGED" }, null), "merged");
});

// The base pinned this as "queue-like states other than QUEUED block the merge
// prefix": a DEQUEUED row with GitHub still saying OPEN must not fold to open,
// which mergePrefix would select. The wire now names the states it knows and
// folds the rest to unknown, which blocks.
test("a state gh-stack names that this build does not folds to unknown, never to open", () => {
  for (const known of ["OPEN", "CLOSED", "MERGED", "QUEUED"] as const) {
    assert.equal(stackPrStateSchema.parse(known), known);
  }
  const dequeued = stackPrStateSchema.parse("DEQUEUED");
  assert.equal(dequeued, "unknown");
  assert.equal(stackPrStateSchema.parse(undefined), "unknown");

  assert.equal(lifecycleOf(row, { state: dequeued }, github("OPEN")), "unknown");
  assert.equal(lifecycleOf(row, { state: dequeued }, github("OPEN", true)), "unknown");
  assert.equal(lifecycleOf(row, { state: dequeued }, null), "unknown");
  // Neither does gh-stack's own queue flag vouch for a state it could not name.
  assert.equal(lifecycleOf({ ...row, isQueued: true }, { state: dequeued }, null), "unknown");
  // The terminal states still win: either source saying so settles the PR.
  assert.equal(lifecycleOf(row, { state: dequeued }, github("MERGED")), "merged");
  assert.equal(lifecycleOf(row, { state: dequeued }, github("CLOSED")), "closed");
  assert.equal(lifecycleOf({ ...row, isMerged: true }, { state: dequeued }, null), "merged");
});

const FRESH_MS = 60_000;
const MAX_AGE_MS = 30 * 60_000;

const meta = (title: string, isDraft = false, state: GithubPrState = "OPEN"): PrMetadata => ({
  title,
  isDraft,
  state,
});

const cacheOf = (entries: [number, PrMetadata, number][]): PrMetadataCache =>
  new Map(entries.map(([number, data, at]) => [number, { data, at }]));

test("fresh entries are served without a read", () => {
  const cache = cacheOf([[1, meta("one"), 1000]]);
  const { hits, missing } = partitionPrMetadata(cache, [1], 1000 + FRESH_MS, FRESH_MS);
  assert.deepEqual(missing, []);
  assert.deepEqual(hits.get(1), { data: meta("one"), stale: false });
});

test("entries past the freshness window are re-read", () => {
  const cache = cacheOf([[1, meta("one"), 1000]]);
  const { hits, missing } = partitionPrMetadata(cache, [1, 2], 1000 + FRESH_MS + 1, FRESH_MS);
  assert.deepEqual(missing, [1, 2]);
  assert.equal(hits.size, 0);
});

test("a successful read replaces the cached values and clears stale", () => {
  const cache = cacheOf([[1, meta("old"), 0]]);
  const resolved = applyPrMetadataReads(
    cache,
    [1],
    new Map([[1, meta("new", true)]]),
    5_000,
    MAX_AGE_MS,
  );
  assert.deepEqual(resolved.get(1), { data: meta("new", true), stale: false });
  assert.deepEqual(cache.get(1), { data: meta("new", true), at: 5_000 });
});

// The reason the cache exists: a rate-limited read must not collapse a row to
// its branch name.
test("a failed read serves the previous values, marked stale", () => {
  const cache = cacheOf([[1, meta("kept"), 0]]);
  const resolved = applyPrMetadataReads(cache, [1], new Map(), 10_000, MAX_AGE_MS);
  assert.deepEqual(resolved.get(1), { data: meta("kept"), stale: true });
  // The timestamp does not advance, so the entry still ages out on schedule.
  assert.equal(cache.get(1)?.at, 0);
});

test("values past the maximum age are dropped rather than served", () => {
  const cache = cacheOf([[1, meta("ancient"), 0]]);
  const resolved = applyPrMetadataReads(cache, [1], new Map(), MAX_AGE_MS + 1, MAX_AGE_MS);
  assert.equal(resolved.has(1), false);
  assert.equal(cache.has(1), false);
});

test("a repeatedly failing read cannot refresh its own stale entry", () => {
  const cache = cacheOf([[1, meta("kept"), 0]]);
  for (const now of [10_000, 20_000, MAX_AGE_MS]) {
    const resolved = applyPrMetadataReads(cache, [1], new Map(), now, MAX_AGE_MS);
    assert.deepEqual(resolved.get(1), { data: meta("kept"), stale: true });
  }
  assert.equal(cache.has(1), true);
  const expired = applyPrMetadataReads(cache, [1], new Map(), MAX_AGE_MS + 1, MAX_AGE_MS);
  assert.equal(expired.has(1), false);
  assert.equal(cache.has(1), false);
});

test("a partial read keeps the covered PRs fresh and the rest stale", () => {
  const cache = cacheOf([
    [1, meta("one"), 0],
    [2, meta("two"), 0],
  ]);
  const resolved = applyPrMetadataReads(
    cache,
    [1, 2, 3],
    new Map([[1, meta("one v2")]]),
    5_000,
    MAX_AGE_MS,
  );
  assert.deepEqual(resolved.get(1), { data: meta("one v2"), stale: false });
  assert.deepEqual(resolved.get(2), { data: meta("two"), stale: true });
  // Never seen and not returned: the caller shows state-only for it.
  assert.equal(resolved.has(3), false);
});

test("eviction keeps live PRs and drops the rest", () => {
  const cache = cacheOf([
    [1, meta("one"), 0],
    [2, meta("two"), 0],
    [3, meta("three"), 0],
  ]);
  evictAbsentPrMetadata(cache, [2]);
  assert.deepEqual([...cache.keys()], [2]);
});
