// PR title, draft flag, and authoritative state — the fields `gh stack view
// --json` omits. Reading them is the panel's only per-PR GitHub cost, so they
// are read for the whole stack at once and cached per workspace.
//
// The cache exists to survive a failed read, not only to save calls: when
// GitHub cannot be reached (rate limit, network, auth), a row that falls back
// to its branch name looks like a different PR. Serving the last known values,
// marked stale, keeps the panel readable and honest.

export type PrMetadata = {
  title: string | null;
  isDraft: boolean;
  state: string;
};

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
export function evictAbsentPrMetadata(
  cache: PrMetadataCache,
  live: readonly number[],
): void {
  const keep = new Set(live);
  for (const number of cache.keys()) {
    if (!keep.has(number)) cache.delete(number);
  }
}
