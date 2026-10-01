import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CHANGED_COALESCE_MS,
  CHANNELS,
  type ChangedPayload,
  type OpenPayload,
  type SettingsPayload,
} from "../../shared/contracts/channels.ts";
import type { LocalReviewData } from "./vendor/review/src/review-api/local-data.ts";
import type { ReviewStore } from "./vendor/review/src/review-api/store.ts";

/** Typed publishers for the three plugin channels (design §3.3). */
export interface Realtime {
  /** Coalesced per key over `CHANGED_COALESCE_MS`. */
  changed(payload: ChangedPayload): void;
  open(payload: OpenPayload): void;
  settings(payload: SettingsPayload): void;
  /** Flush nothing, drop pending timers. Idempotent. */
  dispose(): void;
}

/** One coalescing slot per invalidation target: a later payload replaces an earlier one. */
function changedKey(payload: ChangedPayload): string {
  switch (payload.kind) {
    case "review":
    case "activity":
      return `${payload.kind}:${payload.reviewId}`;
    case "worktree":
      return `worktree:${payload.repositoryId}`;
    case "catalog":
    case "coverage":
      return payload.kind;
  }
}

/**
 * bb broadcasts every publish to every client, so `changed` is trailing-edge
 * coalesced: the first event for a key opens a 50 ms window, later events in
 * the window replace its payload, and one publish carries the latest.
 * After `dispose` every call is a no-op, because the `bb` handle is stale.
 */
export function createRealtime(bb: BbPluginApi): Realtime {
  const pending = new Map<string, { payload: ChangedPayload; timer: NodeJS.Timeout }>();
  let disposed = false;

  const publish = (channel: string, payload: unknown) => {
    if (disposed) return;
    try {
      bb.realtime.publish(channel, payload);
    } catch (error) {
      // A publish runs inside store listeners and timers; it must never throw there.
      bb.log.warn(`whiteboard: realtime publish on ${channel} failed: ${String(error)}`);
    }
  };

  return {
    changed(payload) {
      if (disposed) return;
      const key = changedKey(payload);
      const slot = pending.get(key);
      if (slot) {
        slot.payload = payload;
        return;
      }
      const timer = setTimeout(() => {
        const fired = pending.get(key);
        pending.delete(key);
        if (fired) publish(CHANNELS.changed, fired.payload);
      }, CHANGED_COALESCE_MS);
      timer.unref?.();
      pending.set(key, { payload, timer });
    },
    open(payload) {
      publish(CHANNELS.open, payload);
    },
    settings(payload) {
      publish(CHANNELS.settings, payload);
    },
    dispose() {
      disposed = true;
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

/** The engine sources `whiteboard:changed` invalidates on: upstream's four watch subscriptions. */
export type ChangeSources = {
  store: Pick<ReviewStore, "subscribe" | "subscribeCatalog"> & {
    activity: Pick<ReviewStore["activity"], "subscribe">;
  };
  data?: Pick<LocalReviewData, "subscribeCoverage">;
};

/**
 * Publish an invalidation for every engine change (design §1.3). Returns the
 * unsubscribe the engine's dispose hook runs.
 */
export function publishEngineChanges(realtime: Realtime, sources: ChangeSources): () => void {
  const stops = [
    sources.store.subscribe((result) =>
      realtime.changed({ kind: "review", reviewId: result.reviewId, version: result.version }),
    ),
    sources.store.activity.subscribe((reviewId) =>
      realtime.changed({ kind: "activity", reviewId }),
    ),
    sources.store.subscribeCatalog(() => realtime.changed({ kind: "catalog" })),
    sources.data?.subscribeCoverage(() => realtime.changed({ kind: "coverage" })),
  ];
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops) stop?.();
  };
}
