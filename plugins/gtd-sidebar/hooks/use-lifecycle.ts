import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type ExperimentalRpcOptimisticCache,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { toast } from "sonner";
import {
  canPark,
  formatWakeTime,
  isThreadWorking,
  nextWakeDelayMs,
  predictLifecycleRows,
  resolveShelf,
  type LifecyclePrediction,
  type ThreadActivitySignals,
  type ThreadLifecycleRow,
  type ThreadShelf,
} from "../lib/lifecycle";
import { gtdSidebarRpcContract } from "../lib/rpc-contract";
import { rosterFamilyIds } from "../lib/thread-family";
import { useCommittedEvent } from "./use-committed-event";
import { useOrderedWrites } from "./use-ordered-writes";
import { usePaintGate } from "./use-paint-gate";

const LIFECYCLE_READ = {};

interface LifecycleWrite {
  threadId: string;
  /** null wakes the family. */
  snoozedUntil: number | null;
  prediction: LifecyclePrediction;
}

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
 * The rows are bb's cached `listLifecycle` read, so a remounted sidebar draws
 * the last shelves at once and every window refreshes when the backend
 * invalidates the read. A refresh that fails keeps the rows on screen.
 *
 * `now` is state, not a render-time clock read: a snooze that elapses must
 * move its row without waiting for an unrelated re-render, and re-reading the
 * clock during render would make the classification unstable.
 *
 * Snooze and wake draw on the click: the family comes from `threads`, the
 * sidebar's own roster. Writes go out one at a time in click order, so an
 * Undo always lands after its snooze; each draws here until it answers, and
 * bb's prediction then holds it until a read taken after the write lands. A
 * failed write drops it. Before the first read lands, writes draw over the
 * rows the newest write answered with. The backend's database stays the
 * record.
 */
export function useLifecycle(threads: readonly PluginSidebarThread[]): LifecycleApi {
  const { data, isLoading } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listLifecycle",
    input: LIFECYCLE_READ,
  });
  const shelvesReady = usePaintGate(isLoading);
  const [now, setNow] = useState(() => Date.now());

  // bb asks for a write's prediction once, while `mutate` runs. The family and
  // its timestamp are fixed before then, so replaying the update is pure.
  const nextPrediction = useRef<LifecyclePrediction | null>(null);
  const optimistic = (
    _input: unknown,
    cache: ExperimentalRpcOptimisticCache<typeof gtdSidebarRpcContract>,
  ) => {
    const prediction = nextPrediction.current;
    if (prediction === null) return;
    cache.update("listLifecycle", LIFECYCLE_READ, (current) => ({
      rows: predictLifecycleRows(current.rows, prediction),
    }));
  };
  const snoozeWrite = useRpcMutation({
    contract: gtdSidebarRpcContract,
    method: "snooze",
    optimistic,
  });
  const wakeWrite = useRpcMutation({
    contract: gtdSidebarRpcContract,
    method: "unsnooze",
    optimistic,
  });

  const writes = useOrderedWrites(({ threadId, snoozedUntil, prediction }: LifecycleWrite) => {
    nextPrediction.current = prediction;
    try {
      return snoozedUntil === null
        ? wakeWrite.mutate({ threadId })
        : snoozeWrite.mutate({ threadId, snoozedUntil });
    } finally {
      nextPrediction.current = null;
    }
  });
  const base = data?.rows ?? writes.answer?.rows;
  // bb keeps an unchanged read's rows, so a refresh that changes nothing
  // leaves the map, and the sidebar's partition, alone.
  const drawn = useMemo(() => {
    const rows = writes.unsettled.reduce<readonly ThreadLifecycleRow[]>(
      (current, { prediction }) => predictLifecycleRows(current, prediction),
      base ?? [],
    );
    return new Map(rows.map((row) => [row.threadId, row]));
  }, [base, writes.unsettled]);

  // Arm one timer for the soonest wake instead of polling: the shelf empties
  // the moment a snooze expires, and nothing ticks while nothing is snoozed.
  useEffect(() => {
    // Read a fresh clock here rather than trusting `now`: `now` is only
    // updated when a timer fires, so arming from it after a long idle period
    // would schedule a new snooze far too late.
    const armedAt = Date.now();
    const snoozedUntilValues = [...drawn.values()].map((row) => row.snoozedUntil);
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

  const write = useCommittedEvent((threadId: string, snoozedUntil: number | null) => {
    const threadIds = rosterFamilyIds(threads, threadId);
    const family = new Set(threadIds);
    const prediction: LifecyclePrediction = {
      threadIds,
      // Never earlier than the family's latest attention: bb stamps that on
      // its own clock, and a snooze that predates it wakes at once.
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
    };
    return writes.write({ threadId, snoozedUntil, prediction });
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
