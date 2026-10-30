import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CHANNELS, type OpenPayload } from "../../shared/contracts/channels.ts";
import { CATALOG_TAG, LIVE_SESSION_TAG, sessionTag } from "../../shared/contracts/rpc.ts";
import type { LocalReviewData } from "./review/local-data.ts";
import type { ReviewStore } from "./review/store.ts";

/** The coalescing window for live-read invalidations. */
export const INVALIDATE_COALESCE_MS = 50;

/** What the engine tells clients: live-read invalidations and agents' opens. */
export interface Realtime {
  /** Refresh live reads carrying any of these tags; coalesced over `INVALIDATE_COALESCE_MS`. */
  invalidate(tags: readonly string[]): void;
  open(payload: OpenPayload): void;
  /** Drop pending invalidations. Idempotent. */
  dispose(): void;
}

/**
 * bb sends every invalidation to every client of the plugin, so they are
 * trailing-edge coalesced: the first opens a 50 ms window, later tags join
 * it, and one `experimental_invalidate` carries them all. After `dispose`
 * every call is a no-op, because the `bb` handle is stale.
 */
export function createRealtime(bb: BbPluginApi): Realtime {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  // Both run inside store listeners and timers; they must never throw there.
  const report = (what: string, error: unknown) =>
    bb.log.warn(`whiteboard: ${what} failed: ${String(error)}`);

  const flush = () => {
    timer = undefined;
    const tags = [...pending];
    pending.clear();
    if (disposed || tags.length === 0) return;
    try {
      bb.rpc.experimental_invalidate(tags);
    } catch (error) {
      report("invalidating live reads", error);
    }
  };

  return {
    invalidate(tags) {
      if (disposed) return;
      for (const tag of tags) pending.add(tag);
      if (timer) return;
      timer = setTimeout(flush, INVALIDATE_COALESCE_MS);
      timer.unref?.();
    },
    open(payload) {
      if (disposed) return;
      try {
        bb.realtime.publish(CHANNELS.open, payload);
      } catch (error) {
        report(`realtime publish on ${CHANNELS.open}`, error);
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

/** The engine changes live reads follow. */
export type ChangeSources = {
  store: Pick<ReviewStore, "subscribe" | "subscribeCatalog"> & {
    activity: Pick<ReviewStore["activity"], "subscribe">;
  };
  data?: Pick<LocalReviewData, "subscribeCoverage">;
};

/**
 * Invalidate the live reads each engine change affects: a session's document
 * or activity its `liveSession` reads, the listing `sessions`, and coverage
 * both the catalog's rows and every `liveSession` (its `coverageRevision`).
 * Returns the unsubscribe the engine's dispose runs.
 */
export function publishEngineChanges(realtime: Realtime, sources: ChangeSources): () => void {
  const stops = [
    sources.store.subscribe((result) => realtime.invalidate([sessionTag(result.reviewId)])),
    sources.store.activity.subscribe((reviewId) => realtime.invalidate([sessionTag(reviewId)])),
    sources.store.subscribeCatalog(() => realtime.invalidate([CATALOG_TAG])),
    sources.data?.subscribeCoverage(() => realtime.invalidate([CATALOG_TAG, LIVE_SESSION_TAG])),
  ];
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops) stop?.();
  };
}
