import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import {
  canPark,
  isThreadWorking,
  nextWakeDelayMs,
  resolveShelf,
  rowsMatch,
  wokenSettledThreadIds,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "@/lib/lifecycle";
import { readWarmStartRows, writeWarmStartRows } from "@/lib/warm-start";
import { useRetryingRead } from "@/hooks/use-retrying-read";

function signalsFor(thread: PluginSidebarThread): ThreadActivitySignals {
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    isWorking: isThreadWorking(thread),
    isUnread: thread.isUnread,
    latestAttentionAt: thread.latestAttentionAt,
  };
}

export interface LifecycleApi {
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  /**
   * Every thread the plugin has parked. Settling archives a thread in bb, so
   * the list needs this to keep showing the ones it put away itself.
   */
  parkedThreadIds: ReadonlySet<string>;
  /**
   * The parked rows themselves, keyed by thread id.
   *
   * `parkedThreadIds` answers whether a thread already on screen is parked.
   * This answers what the plugin knows about a thread that is not on screen at
   * all, which is the only question a settled thread can be asked before
   * `listSettledThreads` lands: settling archives it, so bb reports nothing and
   * the row is the whole of what a fresh mount holds about it.
   */
  parkedRows: ReadonlyMap<string, ThreadLifecycleRow>;
  /**
   * Whether the shelves are worth painting yet. True from the first render
   * when a cached snapshot seeds them, and true once the first read settles
   * either way — a FAILED read counts as ready on purpose, because a gate that
   * waits forever on a backend that is down leaves the sidebar permanently
   * blank, which is worse than any flicker.
   *
   * It does not mean the rows came from the server, and nothing may be written
   * on the strength of it.
   */
  shelvesReady: boolean;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  settle(threadId: string): void;
  unsettle(threadId: string): void;
  snooze(threadId: string, snoozedUntil: number): void;
  unsnooze(threadId: string): void;
}

/**
 * How long the list may stay blank waiting for the first `listLifecycle`.
 * Long enough that a warm same-origin round trip wins it outright, short
 * enough that a wedged backend costs a flicker instead of an empty sidebar.
 */
const SHELF_GATE_MS = 250;

/**
 * Reads the plugin's own lifecycle store and classifies threads onto shelves.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(threads: readonly PluginSidebarThread[]): LifecycleApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  // One read, at the only moment that can still beat the first paint.
  // `useState` and not `useMemo`: React is free to throw a memo away and run
  // it again, and a second read would see whatever the origin holds by then.
  const [seededRows] = useState(() => readWarmStartRows());
  const [rows, setRows] = useState<ReadonlyMap<string, ThreadLifecycleRow>>(
    () => new Map((seededRows ?? []).map((row) => [row.threadId, row])),
  );
  const [now, setNow] = useState(() => Date.now());
  // Two questions, and one flag cannot answer both. This one asks whether the
  // shelves may be painted; a cache hit says yes immediately.
  const [shelvesReady, setShelvesReady] = useState(seededRows !== null);
  // This one asks whether the server has spoken for itself, and only it may
  // gate a write. Seeded rows are a guess, and the reconcile effect below
  // un-settles threads: acting on a guess would take bb's archive off a thread
  // and delete a row another window had just replaced.
  const [serverRowsLoaded, setServerRowsLoaded] = useState(false);

  // A response belonging to a mount that is already gone must not reach the
  // cache. Its `requestSeq` is its own, so nothing in the instance that
  // replaced it can reject the older rows, and the next remount would seed
  // from them.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Responses can land out of order (a mutation's refresh racing a realtime
  // one), and an older list would silently restore state the user just
  // changed. Only the newest request may write.
  const requestSeq = useRef(0);
  const readLifecycle = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listLifecycle", {});
      if (seq !== requestSeq.current) return;
      // A seeded list usually agrees with the response that follows it, and
      // with every publish any window makes afterwards. `rowsMatch` is what
      // stops each of those from re-partitioning the whole sidebar.
      setRows((current) =>
        rowsMatch(current, result.rows)
          ? current
          : new Map(result.rows.map((row) => [row.threadId, row])),
      );
      setServerRowsLoaded(true);
      // After the state, not before it: what is on screen must never depend on
      // the cache write having gone through.
      if (mountedRef.current) writeWarmStartRows(result.rows);
    } catch (error) {
      // A rejection belonging to a superseded read is not this one's to answer
      // for; the newest request owns the retry as well as the write.
      if (seq !== requestSeq.current) return;
      throw error;
    } finally {
      // Runs before a rejection leaves this function, which is the point: the
      // gate opens on the first answer of either kind and never waits on a
      // retry. A gate held shut by a backend that is down would render an
      // empty sidebar rather than a stale one.
      setShelvesReady(true);
    }
  }, [rpc]);

  // The shelves keep whatever they already had, and the read comes back for
  // them. Without a retry a single failure would also pin `serverRowsLoaded`
  // false for the life of the mount, and that is what holds the reconcile
  // effect below — and with it bb's archive — shut.
  const refresh = useRetryingRead(readLifecycle);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtime("lifecycle", () => {
    refresh();
  });

  // `rpc.call` is a plain fetch with no timeout, so a backend that accepts the
  // connection and never answers neither resolves nor rejects: no branch of the
  // read above runs, not even its `finally`, and no retry is ever armed. This
  // is the floor under the gate — after it, the sidebar paints what it has.
  useEffect(() => {
    if (shelvesReady) return;
    const timer = setTimeout(() => setShelvesReady(true), SHELF_GATE_MS);
    return () => clearTimeout(timer);
  }, [shelvesReady]);

  // A publish is ephemeral: one that lands while the socket is down is simply
  // gone, and a seeded snapshot would then stand unchallenged for the rest of
  // the session. Only a RE-connection re-reads — the first connect is the
  // mount, whose own read is already in flight.
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (previous === "reconnecting" && connectionState === "connected") {
      refresh();
    }
  }, [connectionState, refresh]);

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const delay = nextWakeDelayMs(
      [...rows.values()].flatMap((row) => (row.snoozedUntil === null ? [] : [row.snoozedUntil])),
      armedAt,
    );
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, rows]);

  // A settled thread that comes back has to come back everywhere. The shelf
  // already reads it as active, and this is what makes the store agree — and
  // with it bb's archive, which `unsettle` takes off again. Ids in flight are
  // held so a slow round trip cannot fire the same unsettle twice.
  const wakingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // The one place the seeded rows are not allowed. This effect deletes rows
    // and unarchives threads, and bb's own thread data is already warm on a
    // remount, so without this guard a cached row plus fresh activity would
    // destroy a park that another window or device had set in the meantime.
    if (!serverRowsLoaded) return;
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const woken = wokenSettledThreadIds(
      rows.values(),
      (threadId) => {
        const thread = threadById.get(threadId);
        return thread === undefined ? undefined : signalsFor(thread);
      },
      now,
    );
    for (const threadId of woken) {
      if (wakingRef.current.has(threadId)) continue;
      wakingRef.current.add(threadId);
      void rpc
        .call("unsettle", { threadId })
        .catch(() => {
          // A failed reconcile is retried on the next thread update; the
          // thread is already back in the inbox either way.
        })
        .finally(() => wakingRef.current.delete(threadId));
    }
  }, [now, rows, rpc, serverRowsLoaded, threads]);

  // Hoisted out of the api object below, which the clock invalidates every
  // minute: this set decides which archived threads stay visible, and a new
  // one re-filters and re-sorts the entire list.
  const parkedThreadIds = useMemo(() => new Set(rows.keys()), [rows]);

  return useMemo<LifecycleApi>(() => {
    // One read per mutation: the write publishes on the realtime channel, and
    // that subscription already triggers a refresh for every client.
    const mutate = async (method: "settle" | "unsettle" | "unsnooze", threadId: string) => {
      await rpc.call(method, { threadId });
    };
    return {
      shelfFor: (thread) => resolveShelf(rows.get(thread.id), signalsFor(thread), now),
      // A row only ever exists for a parked thread, so its keys are the set.
      parkedThreadIds,
      parkedRows: rows,
      shelvesReady,
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      settle: (threadId) => void mutate("settle", threadId),
      unsettle: (threadId) => void mutate("unsettle", threadId),
      unsnooze: (threadId) => void mutate("unsnooze", threadId),
      snooze: (threadId, snoozedUntil) => {
        void rpc.call("snooze", { threadId, snoozedUntil });
      },
    };
  }, [now, parkedThreadIds, rows, rpc, shelvesReady]);
}
