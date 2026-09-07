import { useCallback, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { gtdSidebarRpcContract } from "@/server";
import {
  isWithinSettledWindow,
  settledRowsMatch,
  toSidebarThread,
  type SettledThreadRow,
} from "@/lib/settled-threads";
import { useLifecycleChannelList } from "@/hooks/use-lifecycle-channel-list";

const EMPTY: readonly SettledThreadRow[] = [];

export interface SettledThreadsApi {
  /** Archived threads, newest archive first, cut to the window against the caller's clock. */
  threads: readonly PluginSidebarThread[];
  /**
   * Whether the shelf is worth painting yet. This list is the ONLY source of a
   * settled thread, and it is a round trip behind on every mount, so a user
   * whose threads are all settled would otherwise be told they have none for
   * exactly that long.
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
  const ready = useLifecycleChannelList(
    useCallback(() => rpc.call("listSettledThreads", {}), [rpc]),
    useCallback((result) => {
      setRows((current) => (settledRowsMatch(current, result.threads) ? current : result.threads));
    }, []),
  );

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
