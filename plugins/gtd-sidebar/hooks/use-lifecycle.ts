import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import {
  canPark,
  isThreadWorking,
  nextWakeDelayMs,
  resolveShelf,
  rowsMatch,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "@/lib/lifecycle";
import { useLifecycleChannelList } from "@/hooks/use-lifecycle-channel-list";

function signalsFor(thread: PluginSidebarThread): ThreadActivitySignals {
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    isWorking: isThreadWorking(thread),
    latestAttentionAt: thread.latestAttentionAt,
  };
}

export interface LifecycleApi {
  shelfFor(thread: PluginSidebarThread): ThreadShelf;
  /**
   * Whether the shelves are worth painting yet: true once the first read
   * resolves or rejects. It does not mean the rows came from the server, and
   * nothing may be written on the strength of it.
   */
  shelvesReady: boolean;
  canPark(thread: PluginSidebarThread): boolean;
  wakeAtFor(thread: PluginSidebarThread): number | null;
  /** When the current snooze began; null while the thread is not snoozed. */
  snoozedAtFor(thread: PluginSidebarThread): number | null;
  snooze(threadId: string, snoozedUntil: number): void;
  unsnooze(threadId: string): void;
}

/**
 * Reads the plugin's own lifecycle store and classifies threads onto shelves.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 */
export function useLifecycle(): LifecycleApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [rows, setRows] = useState<ReadonlyMap<string, ThreadLifecycleRow>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const shelvesReady = useLifecycleChannelList(
    useCallback(() => rpc.call("listLifecycle", {}), [rpc]),
    useCallback((result) => {
      // Most publishes re-read a list that has not changed. `rowsMatch` is what
      // stops each of those from re-partitioning the whole sidebar.
      setRows((current) =>
        rowsMatch(current, result.rows)
          ? current
          : new Map(result.rows.map((row) => [row.threadId, row])),
      );
    }, []),
  );

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const snoozedUntilValues = [...rows.values()].flatMap((row) =>
      row.snoozedUntil === null ? [] : [row.snoozedUntil],
    );
    // A wake that is past on the wall clock but still ahead of the rendered
    // clock arms nothing — `nextWakeDelayMs` drops it — and leaves the row
    // parked for good. Catch the rendered clock up and let the next pass arm
    // whatever wakes remain.
    if (snoozedUntilValues.some((value) => value > now && value <= armedAt)) {
      setNow(armedAt);
      return;
    }
    const delay = nextWakeDelayMs(snoozedUntilValues, armedAt);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, rows]);

  // No read after a mutation: the write publishes on the realtime channel, and
  // that subscription already triggers a refresh for every client.
  return useMemo<LifecycleApi>(
    () => ({
      shelfFor: (thread) => resolveShelf(rows.get(thread.id), signalsFor(thread), now),
      shelvesReady,
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => rows.get(thread.id)?.snoozedUntil ?? null,
      snoozedAtFor: (thread) => rows.get(thread.id)?.snoozedAt ?? null,
      unsnooze: (threadId) => {
        void rpc.call("unsnooze", { threadId });
      },
      snooze: (threadId, snoozedUntil) => {
        void rpc.call("snooze", { threadId, snoozedUntil });
      },
    }),
    [now, rows, rpc, shelvesReady],
  );
}
