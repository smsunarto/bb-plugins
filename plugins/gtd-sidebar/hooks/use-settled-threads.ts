import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import {
  isWithinSettledWindow,
  toSidebarThread,
  type SettledThreadRow,
} from "@/lib/settled-threads";
import { useRetryingRead } from "@/hooks/use-retrying-read";

const EMPTY: readonly SettledThreadRow[] = [];

export interface SettledThreadsApi {
  /** Settled threads, cut to the window against the caller's clock. */
  threads: readonly PluginSidebarThread[];
  /**
   * Whether `listSettledThreads` still owes this mount an answer.
   *
   * True from the first render, because the read is issued from an effect and
   * the frame before it has nothing about a settled thread but the warm
   * lifecycle rows. It falls on a read that RESOLVES and on nothing else: a
   * rejection leaves it standing, because the rows that read was going to bring
   * are still real, and the caller's alternative is telling a user whose threads
   * are all settled that they have none. A backend that accepts the connection
   * and never answers leaves it standing for the same reason and for good.
   *
   * Every later read raises it again, which is what covers the gap around a
   * settle: bb evicts the thread from its own view the moment the archive lands,
   * a whole round trip before this read can hand it back.
   *
   * The caller may count parked rows the merge has not been handed while this is
   * true, and must not once it is false — a row still missing from a read that
   * answered is one the backend cannot resolve, and counting it leaves a header
   * standing over a list nothing will fill.
   */
  rowsPending: boolean;
}

/**
 * The threads on the settled shelf, fetched from the plugin's own backend.
 *
 * The host cannot supply them: settling archives the thread, and bb's sidebar
 * view is built from queries pinned to `archived: false`. This hook is the
 * second source that fills that hole, refreshed by the same signals the
 * lifecycle rows use — the shelf and its rows must never disagree about which
 * threads are settled.
 *
 * The rows are kept as the backend sent them and cut to the window on the way
 * out, against the list's own clock. That is what ages a row off the shelf
 * while the sidebar sits open — a cut made once at fetch time would hold a
 * day-old settle on screen until the next unrelated refresh.
 *
 * An object comes back rather than the array alone, for the reason `useLifecycle`
 * returns one: the two values are read at opposite ends of the same render — the
 * threads into the merge at the top, the flag into the shelf count near the
 * bottom — and a named field survives that separation where a positional one
 * does not. A second hook for the flag would issue a second read.
 */
export function useSettledThreads(now: number): SettledThreadsApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [rows, setRows] = useState<readonly SettledThreadRow[]>(EMPTY);
  const [rowsPending, setRowsPending] = useState(true);

  // Responses can land out of order — a settle's publish racing a reconnect —
  // and an older list would put a thread back that the user just restored.
  const requestSeq = useRef(0);
  const readSettledThreads = useCallback(async () => {
    const seq = ++requestSeq.current;
    setRowsPending(true);
    try {
      const result = await rpc.call("listSettledThreads", {});
      if (seq !== requestSeq.current) return;
      setRows(result.threads);
      // Only here, and only for the newest request. Clearing this in a `finally`
      // would drop the flag on a rejection the retry chain is still working
      // through, and clearing it from a superseded read would drop it while the
      // read that replaced it is still in flight.
      setRowsPending(false);
    } catch (error) {
      // A rejection belonging to a superseded read is not this one's to answer
      // for; the newest request owns the retry.
      if (seq !== requestSeq.current) return;
      throw error;
    }
  }, [rpc]);

  // Keep the rows already on screen — a failed read is a stale shelf, and an
  // emptied one would look like the user's settled work had vanished — but keep
  // asking. This list is the ONLY source of a settled thread, so a mount whose
  // first read failed has no row to draw until the next mutation and says
  // nothing about why. `rowsPending` stays true through exactly that, which is
  // what leaves the count — and with it the shelf, and the user's evidence that
  // the threads are still somewhere — standing on the lifecycle rows alone.
  const refresh = useRetryingRead(readSettledThreads);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Every settle, un-settle, snooze, and — through the backend's thread-event
  // bridge — every turn a settled thread takes publishes here.
  useRealtime("lifecycle", () => {
    refresh();
  });

  // A publish that lands while the socket is down is gone for good, and this
  // list has no other clock. Only a RE-connection re-reads; the first connect
  // is the mount, whose own read is already in flight.
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const previous = previousConnectionState.current;
    previousConnectionState.current = connectionState;
    if (previous === "reconnecting" && connectionState === "connected") {
      refresh();
    }
  }, [connectionState, refresh]);

  const threads = useMemo(
    () => rows.filter((row) => isWithinSettledWindow(row.settledAt, now)).map(toSidebarThread),
    [now, rows],
  );

  return useMemo(() => ({ threads, rowsPending }), [rowsPending, threads]);
}
