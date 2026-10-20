import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { toast } from "sonner";
import type { gtdSidebarRpcContract } from "../server";
import {
  canPark,
  formatWakeTime,
  isThreadWorking,
  nextWakeDelayMs,
  resolveShelf,
  rowsMatch,
  withPendingWrites,
  type PendingLifecycleWrite,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "../lib/lifecycle";
import { rosterFamilyIds } from "../lib/thread-family";
import { useCommittedEvent } from "./use-committed-event";
import { useLifecycleChannelList } from "./use-lifecycle-channel-list";

const LIFECYCLE_REFRESHES = ["lifecycle"] as const;

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
  /** Parks the family on the click; a failed write puts it back. */
  snooze(threadId: string, snoozedUntil: number): void;
  /** Wakes the family on the click; a failed write parks it again. */
  unsnooze(threadId: string): void;
}

/**
 * Reads the plugin's own lifecycle store and classifies threads onto shelves.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 *
 * Snooze and wake draw on the click. The family comes from `threads`, the
 * sidebar's own roster, and sits on top of the stored rows until the backend
 * answers with every row after its write; a failed write simply drops off.
 * The backend's database stays the record, so other devices follow its
 * publish as before.
 *
 * A write's answer is a snapshot from when it ran, and it can arrive after a
 * newer read, for example one showing another window's Wake. So once the
 * last write settles, one more read starts, and whatever it finds stands.
 */
export function useLifecycle(threads: readonly PluginSidebarThread[]): LifecycleApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [rows, setRows] = useState<ReadonlyMap<string, ThreadLifecycleRow>>(() => new Map());
  const [pending, setPending] = useState<readonly PendingLifecycleWrite[]>([]);
  const lastWriteId = useRef(0);
  // Counts answered writes. A read that started before one may predate it,
  // and is dropped; the read after the last write settles replaces it.
  const answeredWrites = useRef(0);
  const unsettledWrites = useRef(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const [now, setNow] = useState(() => Date.now());
  // Most publishes re-read a list that has not changed. `rowsMatch` is what
  // stops each of those from re-partitioning the whole sidebar.
  const applyRows = useCallback((next: readonly ThreadLifecycleRow[]) => {
    setRows((current) =>
      rowsMatch(current, next) ? current : new Map(next.map((row) => [row.threadId, row])),
    );
  }, []);
  const { ready: shelvesReady, refresh: reconcile } = useLifecycleChannelList(
    useCallback(async () => {
      const answered = answeredWrites.current;
      return { ...(await rpc.call("listLifecycle", {})), answered };
    }, [rpc]),
    useCallback(
      (result) => {
        if (result.answered === answeredWrites.current) applyRows(result.rows);
      },
      [applyRows],
    ),
    LIFECYCLE_REFRESHES,
  );
  const drawn = useMemo(() => withPendingWrites(rows, pending), [rows, pending]);

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const snoozedUntilValues = [...drawn.values()].flatMap((row) =>
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
  }, [now, drawn]);

  // Undo can follow a snooze before it answers. Writes reach the backend in
  // the order they were made, while each one draws at once.
  const write = useCommittedEvent((threadId: string, snoozedUntil: number | null) => {
    const threadIds = rosterFamilyIds(threads, threadId);
    const family = new Set(threadIds);
    const id = ++lastWriteId.current;
    unsettledWrites.current += 1;
    setPending((current) => [
      ...current,
      {
        id,
        threadIds,
        // Never earlier than the family's latest attention: bb stamps that
        // on its own clock, and a snooze that predates it wakes at once.
        snooze:
          snoozedUntil === null
            ? null
            : {
                snoozedUntil,
                snoozedAt: Math.max(
                  Date.now(),
                  ...threads
                    .filter((thread) => family.has(thread.id))
                    .map((thread) => thread.latestAttentionAt),
                ),
              },
      },
    ]);
    const send = async (): Promise<void> => {
      try {
        const result =
          snoozedUntil === null
            ? await rpc.call("unsnooze", { threadId })
            : await rpc.call("snooze", { threadId, snoozedUntil });
        answeredWrites.current += 1;
        applyRows(result.rows);
      } finally {
        setPending((current) => current.filter((entry) => entry.id !== id));
        unsettledWrites.current -= 1;
        if (unsettledWrites.current === 0) reconcile();
      }
    };
    const written = writes.current.then(send);
    writes.current = written.catch(() => {});
    return written;
  });

  return useMemo<LifecycleApi>(() => {
    const unsnooze = (threadId: string) => {
      write(threadId, null).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Couldn’t wake the thread.");
      });
    };
    return {
      shelfFor: (thread) => resolveShelf(drawn.get(thread.id), signalsFor(thread), now),
      shelvesReady,
      canPark: (thread) => canPark(signalsFor(thread)),
      wakeAtFor: (thread) => drawn.get(thread.id)?.snoozedUntil ?? null,
      snoozedAtFor: (thread) => drawn.get(thread.id)?.snoozedAt ?? null,
      unsnooze,
      // A snooze fires on pointerdown and folds the row into a closed shelf,
      // so the toast is what tells the user where it went. One id per thread:
      // a second snooze replaces the toast instead of stacking another, and a
      // failed write replaces it with the error.
      snooze: (threadId, snoozedUntil) => {
        const toastId = `snooze-${threadId}`;
        toast(`Snoozed until ${formatWakeTime(snoozedUntil, new Date())}`, {
          id: toastId,
          action: { label: "Undo", onClick: () => unsnooze(threadId) },
        });
        write(threadId, snoozedUntil).catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn’t snooze the thread.", {
            id: toastId,
          });
        });
      },
    };
  }, [drawn, now, shelvesReady, write]);
}
