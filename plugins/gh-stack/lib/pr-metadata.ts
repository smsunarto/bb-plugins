import { z } from "zod";

// PR title, draft flag, and authoritative state — the fields `gh stack view
// --json` omits. Reading them is the panel's only per-PR GitHub cost, so they
// are read for the whole stack at once and cached per workspace.
//
// The cache exists to survive a failed read, not only to save calls: when
// GitHub cannot be reached (rate limit, network, auth), a row that falls back
// to its branch name looks like a different PR. Serving the last known values,
// marked stale, keeps the panel readable and honest.

// GitHub's PullRequestState, as `gh pr list` and `gh pr view --json state`
// emit it. A PR in the merge queue is still OPEN here.
export const githubPrStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);
export type GithubPrState = z.infer<typeof githubPrStateSchema>;

// What `gh stack view --json` names a PR's state: GitHub's, or QUEUED for a
// PR it found in the merge queue. Anything else — a state a newer gh-stack
// adds, or a missing field — parses as "unknown" at the wire, so it folds to
// the unknown lifecycle and blocks the merge prefix instead of passing as open.
export const stackPrStateSchema = z
  .enum(["OPEN", "CLOSED", "MERGED", "QUEUED", "unknown"])
  .catch("unknown");
export type StackPrState = z.infer<typeof stackPrStateSchema>;

export type PrMetadata = {
  title: string | null;
  isDraft: boolean;
  state: GithubPrState;
};

// One PR lifecycle, folded once at the server boundary (lifecycleOf) from
// gh-stack's row and GitHub's read. "merged" never reaches the wire: the
// panel projects merged layers away before shipping (see stack-layers).
// "unknown" does: GitHub could not read the PR, or gh-stack named a state
// this build does not know; nothing may act on it.
export const VISIBLE_PR_LIFECYCLES = ["draft", "open", "queued", "closed", "unknown"] as const;
export type VisiblePrLifecycle = (typeof VISIBLE_PR_LIFECYCLES)[number];
export type PrLifecycle = VisiblePrLifecycle | "merged";

// gh stack view can lag GitHub: its isMerged flag stays false after a PR
// merged behind gh-stack's back, while the state it copied already says
// MERGED. Either source saying merged wins. For raw rows only; the wire
// carries the folded lifecycle instead.
export function rawIsMerged(layer: {
  isMerged: boolean;
  pr?: { state: StackPrState } | null;
}): boolean {
  return layer.isMerged || layer.pr?.state === "MERGED";
}

// Fold a `gh stack view` row and GitHub's read of its PR into one lifecycle.
// GitHub is authoritative for the terminal states; gh-stack's queued flag
// survives while GitHub still calls the PR open; draft is GitHub's alone to
// say, so a PR that could not be read reads as open (and stale). Only a row
// gh-stack itself calls OPEN can read as open or draft. The PR row is passed
// apart from the layer so callers that already checked it exists hand over
// the narrowed value.
export function lifecycleOf(
  layer: { isMerged: boolean; isQueued: boolean },
  pr: { state: StackPrState },
  github: Pick<PrMetadata, "isDraft" | "state"> | null,
): PrLifecycle {
  if (layer.isMerged || pr.state === "MERGED" || github?.state === "MERGED") return "merged";
  if (pr.state === "CLOSED" || github?.state === "CLOSED") return "closed";
  // Neither GitHub's OPEN nor gh-stack's queue flag vouches for a state
  // gh-stack named that this build cannot.
  if (pr.state === "unknown") return "unknown";
  if (layer.isQueued || pr.state === "QUEUED") return "queued";
  if (github?.isDraft) return "draft";
  return "open";
}

export type PrMetadataEntry = { data: PrMetadata; at: number };

// `stale` means the values came from an earlier read that could not be
// confirmed. Callers must not present them as current, and must not act on
// them (the draft toggle would send the wrong direction).
export type PrMetadataResolution = { data: PrMetadata; stale: boolean };

export type PrMetadataCache = Map<number, PrMetadataEntry>;

// Split the requested PRs into cache hits and the numbers that need a read.
export function partitionPrMetadata(
  cache: PrMetadataCache,
  numbers: readonly number[],
  now: number,
  freshMs: number,
): { hits: Map<number, PrMetadataResolution>; missing: number[] } {
  const hits = new Map<number, PrMetadataResolution>();
  const missing: number[] = [];
  for (const number of numbers) {
    const entry = cache.get(number);
    if (entry && now - entry.at <= freshMs) {
      hits.set(number, { data: entry.data, stale: false });
    } else {
      missing.push(number);
    }
  }
  return { hits, missing };
}

// Fold a read's results into the cache. A number the read did not cover keeps
// its previous values (flagged stale) until they pass `maxAgeMs`, after which
// the entry is dropped and the caller shows state-only.
export function applyPrMetadataReads(
  cache: PrMetadataCache,
  missing: readonly number[],
  fetched: ReadonlyMap<number, PrMetadata>,
  now: number,
  maxAgeMs: number,
): Map<number, PrMetadataResolution> {
  const resolved = new Map<number, PrMetadataResolution>();
  for (const number of missing) {
    const fresh = fetched.get(number);
    if (fresh) {
      cache.set(number, { data: fresh, at: now });
      resolved.set(number, { data: fresh, stale: false });
      continue;
    }
    const entry = cache.get(number);
    if (!entry) continue;
    if (now - entry.at <= maxAgeMs) {
      resolved.set(number, { data: entry.data, stale: true });
    } else {
      cache.delete(number);
    }
  }
  return resolved;
}

// Drop entries for PRs no longer in the stack (merged, pruned), so a
// long-lived workspace does not accumulate them.
export function evictAbsentPrMetadata(cache: PrMetadataCache, live: readonly number[]): void {
  const keep = new Set(live);
  for (const number of cache.keys()) {
    if (!keep.has(number)) cache.delete(number);
  }
}
