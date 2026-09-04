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

/**
 * How long the list may stay blank waiting for the first `listSettledThreads`.
 * Same floor as the lifecycle read: a wedged backend costs a flicker instead
 * of an empty sidebar.
 */
const SHELF_GATE_MS = 250;

export interface SettledThreadsApi {
  /** Archived threads, newest archive first, cut to the window against the caller's clock. */
  threads: readonly PluginSidebarThread[];
  /**
   * Whether the shelf is worth painting yet. This list is the ONLY source of a
   * settled thread, and it is a round trip behind on every mount, so a user
   * whose threads are all settled would otherwise be told they have none for
   * exactly that long. True once the first read resolves or rejects, or once
   * the gate's own deadline passes.
   */
  ready: boolean;
  unsettle(threadId: string): void;
}

/**
 * The threads on the Settled shelf, fetched from the plugin's own backend.
 *
 * The host cannot supply them: settling archives the thread, and bb's sidebar
 * view is built from queries pinned to `archived: false`. This hook is the
 * second source that fills that hole, refreshed on the same `lifecycle`
 * channel the snooze rows use — the backend publishes there on every archive
 * and un-settle.
 *
 * The rows are kept as the backend sent them and cut to the window on the way
 * out, against the list's own clock. That is what ages a row off the shelf
 * while the sidebar sits open — a cut made once at fetch time would hold a
 * day-old settle on screen until the next unrelated refresh.
 */
export function useSettledThreads(now: number): SettledThreadsApi {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [rows, setRows] = useState<readonly SettledThreadRow[]>(EMPTY);
  const [ready, setReady] = useState(false);

  // Responses can land out of order — a settle's publish racing a reconnect —
  // and an older list would put a thread back that the user just restored.
  const requestSeq = useRef(0);
  const readSettledThreads = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await rpc.call("listSettledThreads", {});
      if (seq !== requestSeq.current) return;
      setRows(result.threads);
    } catch (error) {
      // A rejection belonging to a superseded read is not this one's to answer
      // for; the newest request owns the retry.
      if (seq !== requestSeq.current) return;
      throw error;
    } finally {
      // The gate opens on the first answer of either kind and never waits on
      // a retry: the shelf keeps what it has rather than blanking the list.
      setReady(true);
    }
  }, [rpc]);

  // Keep the rows already on screen — a failed read is a stale shelf, and an
  // emptied one would look like the user's settled work had vanished — but
  // keep asking.
  const refresh = useRetryingRead(readSettledThreads);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtime("lifecycle", () => {
    refresh();
  });

  // `rpc.call` has no timeout, so a backend that accepts the connection and
  // never answers runs no branch of the read above, not even its `finally`.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), SHELF_GATE_MS);
    return () => clearTimeout(timer);
  }, [ready]);

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
    () =>
      rows
        .filter((row) => isWithinSettledWindow(row.settledAt, now))
        .sort((a, b) => b.settledAt - a.settledAt)
        .map(toSidebarThread),
    [now, rows],
  );

  // No read after the mutation: the backend publishes on the lifecycle
  // channel, and that subscription already refreshes every client.
  const unsettle = useCallback(
    (threadId: string) => {
      void rpc.call("unsettle", { threadId });
    },
    [rpc],
  );

  return useMemo(() => ({ threads, ready, unsettle }), [ready, threads, unsettle]);
}
