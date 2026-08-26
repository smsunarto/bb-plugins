import {
  MAX_PR_BACKFILL_PER_TICK,
  buildSnoozedPrWatchQuery,
  canonicalPullRequestUrl,
  diffSnapshots,
  fingerprintOf,
  isGraphqlRateLimited,
  parseSnoozedPrWatchResponse,
  parseStoredSnapshot,
  serializeSnapshot,
  shouldSkipForRateLimit,
  skipUntilMsFromResetAt,
  type PrChange,
  type PrWatchSnapshot,
} from "./pr-watch.ts";

export interface SnoozedWatchTarget {
  threadId: string;
  snoozedUntil: number;
}

export interface StoredPrWatch {
  threadId: string;
  prUrl: string;
  snapshotJson: string | null;
}

export interface PrWatchPollStore {
  listSnoozed(): SnoozedWatchTarget[];
  getWatch(threadId: string): StoredPrWatch | undefined;
  upsertWatch(row: StoredPrWatch & { lastPolledAt: number }): void;
}

export interface PrWatchPollDeps {
  now: number;
  store: PrWatchPollStore;
  graphql: (query: string) => Promise<{ raw: unknown; stderr: string; exitCode: number }>;
  resolvePrUrl: (threadId: string) => Promise<string | null>;
  wakeThread: (
    threadId: string,
    snapshot: PrWatchSnapshot,
    changes: readonly PrChange[],
  ) => Promise<void>;
  log: { info(message: string): void; warn(message: string): void };
  remainingHint: number | null;
  skipUntilMs: number | null;
}

export interface PrWatchPollResult {
  remaining: number | null;
  skipUntilMs: number | null;
  queried: number;
  woken: number;
  baselined: number;
}

export async function pollSnoozedPullRequests(deps: PrWatchPollDeps): Promise<PrWatchPollResult> {
  if (shouldSkipForRateLimit(deps.remainingHint, deps.skipUntilMs, deps.now)) {
    deps.log.info("skipping snoozed PR watch until the GitHub rate limit resets");
    return {
      remaining: deps.remainingHint,
      skipUntilMs: deps.skipUntilMs,
      queried: 0,
      woken: 0,
      baselined: 0,
    };
  }

  const snoozed = deps.store.listSnoozed().filter((row) => row.snoozedUntil > deps.now);

  let backfilled = 0;
  for (const row of snoozed) {
    if (deps.store.getWatch(row.threadId) !== undefined) continue;
    if (backfilled >= MAX_PR_BACKFILL_PER_TICK) break;
    backfilled += 1;
    try {
      const url = await deps.resolvePrUrl(row.threadId);
      const canonical = url === null ? null : canonicalPullRequestUrl(url);
      if (canonical === null) continue;
      deps.store.upsertWatch({
        threadId: row.threadId,
        prUrl: canonical,
        snapshotJson: null,
        lastPolledAt: 0,
      });
    } catch (error) {
      deps.log.warn(`could not resolve a PR for snoozed thread ${row.threadId}: ${String(error)}`);
    }
  }

  const urls: string[] = [];
  const watchersByUrl = new Map<string, string[]>();
  for (const row of snoozed) {
    const watch = deps.store.getWatch(row.threadId);
    if (watch === undefined) continue;
    const canonical = canonicalPullRequestUrl(watch.prUrl);
    if (canonical === null) continue;
    urls.push(canonical);
    const watchers = watchersByUrl.get(canonical) ?? [];
    watchers.push(row.threadId);
    watchersByUrl.set(canonical, watchers);
  }

  if (urls.length === 0) {
    return {
      remaining: deps.remainingHint,
      skipUntilMs: null,
      queried: 0,
      woken: 0,
      baselined: 0,
    };
  }

  const query = buildSnoozedPrWatchQuery(urls);
  const result = await deps.graphql(query);
  const parsed = parseSnoozedPrWatchResponse(result.raw);

  if (
    isGraphqlRateLimited(result.raw, result.stderr) ||
    (result.exitCode !== 0 && parsed.snapshots.length === 0)
  ) {
    const skipUntilMs =
      parsed.rateLimit !== null
        ? skipUntilMsFromResetAt(parsed.rateLimit.resetAt, deps.now)
        : deps.now + 60 * 60 * 1000;
    deps.log.warn("GitHub refused the snoozed PR watch; waiting for the rate limit to reset");
    return {
      remaining: parsed.rateLimit?.remaining ?? 0,
      skipUntilMs,
      queried: 0,
      woken: 0,
      baselined: 0,
    };
  }

  const remaining = parsed.rateLimit?.remaining ?? deps.remainingHint;
  const skipUntilMs =
    parsed.rateLimit !== null && shouldSkipForRateLimit(parsed.rateLimit.remaining, null, deps.now)
      ? skipUntilMsFromResetAt(parsed.rateLimit.resetAt, deps.now)
      : null;

  let woken = 0;
  let baselined = 0;
  const snapshotsByUrl = new Map(
    parsed.snapshots.map((snapshot) => [
      canonicalPullRequestUrl(snapshot.url) ?? snapshot.url,
      snapshot,
    ]),
  );

  for (const [url, threadIds] of watchersByUrl) {
    const snapshot = snapshotsByUrl.get(url);
    if (snapshot === undefined) continue;
    const nextJson = serializeSnapshot(snapshot);
    const nextFingerprint = fingerprintOf(snapshot);

    for (const threadId of threadIds) {
      const watch = deps.store.getWatch(threadId);
      const previous = parseStoredSnapshot(watch?.snapshotJson ?? null);
      if (previous === null) {
        deps.store.upsertWatch({
          threadId,
          prUrl: url,
          snapshotJson: nextJson,
          lastPolledAt: deps.now,
        });
        baselined += 1;
        continue;
      }

      if (fingerprintOf(previous) === nextFingerprint) {
        deps.store.upsertWatch({
          threadId,
          prUrl: url,
          snapshotJson: nextJson,
          lastPolledAt: deps.now,
        });
        continue;
      }

      const changes = diffSnapshots(previous, snapshot);
      if (changes.length === 0) {
        deps.store.upsertWatch({
          threadId,
          prUrl: url,
          snapshotJson: nextJson,
          lastPolledAt: deps.now,
        });
        continue;
      }

      try {
        await deps.wakeThread(threadId, snapshot, changes);
        woken += 1;
      } catch (error) {
        // Leave the previous snapshot in place so the next hour retries the
        // same diff. Restoring the new snapshot here would swallow a failed
        // wake and never ask again.
        deps.log.warn(`could not wake snoozed thread ${threadId}: ${String(error)}`);
      }
    }
  }

  if (parsed.rateLimit !== null) {
    deps.log.info(
      `snoozed PR watch queried ${parsed.snapshots.length} PRs, cost ${parsed.rateLimit.cost}, ${parsed.rateLimit.remaining}/${parsed.rateLimit.limit} remaining`,
    );
  }

  return {
    remaining,
    skipUntilMs,
    queried: parsed.snapshots.length,
    woken,
    baselined,
  };
}
