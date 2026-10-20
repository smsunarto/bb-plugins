import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { InboxPr, PrTab } from "../shared/schema.ts";
import { absoluteTime, relativeTime } from "./format.ts";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { LOCAL_READS } from "./local-cache.ts";
import { cn } from "./lib/utils.ts";

/** What SyncState reads from a TanStack query. */
export type SyncQuery = {
  dataUpdatedAt: number;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
};

/**
 * A page's freshness from its own read and the open tab's: as old as the
 * oldest, syncing while either is. Only `own`'s failure is reported here; a
 * tab reports its own failure where its data is.
 */
export function pageSync(own: SyncQuery, tab: SyncQuery | null): SyncQuery {
  if (!tab?.dataUpdatedAt) return own;
  return {
    dataUpdatedAt: own.dataUpdatedAt
      ? Math.min(own.dataUpdatedAt, tab.dataUpdatedAt)
      : tab.dataUpdatedAt,
    isFetching: own.isFetching || tab.isFetching,
    isError: own.isError,
    error: own.error,
    refetch: () => Promise.all([own.refetch(), tab.refetch()]),
  };
}

/** How often "Updated 2m ago" moves on. */
const TICK_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * How old the shown copy is. A read failure keeps the last local copy visible,
 * says so with the reason on hover, and offers to ask GitHub again.
 */
export function SyncState({
  query,
  errorsOnly = false,
  className,
}: {
  query: SyncQuery;
  /**
   * Shows only a failed refresh: for a tab whose age and syncing the page
   * header already reports (`pageSync`), so nothing shifts on each poll.
   */
  errorsOnly?: boolean;
  /** Placement, such as padding; each caller sets its own. */
  className?: string;
}) {
  const now = useNow();
  if (!query.dataUpdatedAt) return null;
  const at = new Date(query.dataUpdatedAt).toISOString();
  // A read stamped ahead of this clock still reads "just now".
  const age = relativeTime(at, Math.max(now, query.dataUpdatedAt));
  if (query.isError && !query.isFetching) {
    return (
      <output
        className={cn("flex min-w-0 items-center gap-1 text-[11px] text-warning-text", className)}
        title={errorText(query.error)}
      >
        <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Not updated · showing the copy from {age}</span>
        <button
          type="button"
          className="shrink-0 rounded px-1 underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => void query.refetch()}
        >
          Retry
        </button>
      </output>
    );
  }
  if (errorsOnly) return null;
  return (
    <output
      className={cn("text-[11px] text-subtle-foreground", className)}
      title={`Read from GitHub ${absoluteTime(at)}`}
    >
      {query.isFetching ? "Syncing with GitHub…" : `Updated ${age}`}
    </output>
  );
}

/** Realtime reconnects may miss activity; reconcile mounted reads once per connection transition. */
export function useReconcile(): void {
  const state = useRealtimeConnectionState();
  const previous = useRef(state);
  useEffect(() => {
    if (state === "connected" && previous.current !== "connected") {
      for (const method of LOCAL_READS) {
        void pluginQueryClient.invalidateQueries({ queryKey: [method] }, { cancelRefetch: false });
      }
    }
    previous.current = state;
  }, [state]);
}

// Prefetch has a global concurrency cap, so moving across many rows cannot flood gh.
let activePrefetches = 0;
/** A short hover/focus dwell, a two-read cap, and TanStack deduplication bound speculative work. */
export function usePrPrefetch() {
  const client = rpc.useClient();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (pr: Pick<InboxPr, "account" | "ref">, tab: PrTab = "summary") => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (activePrefetches >= 2) return;
      activePrefetches++;
      const input = { account: pr.account, ref: pr.ref };
      const request =
        tab === "changes"
          ? pluginQueryClient.prefetchQuery({
              queryKey: rpc.changedFiles.queryKey(input),
              queryFn: () => client.changedFiles(input),
              staleTime: 30_000,
            })
          : tab === "checks"
            ? pluginQueryClient.prefetchQuery({
                queryKey: rpc.checks.queryKey(input),
                queryFn: () => client.checks(input),
                staleTime: 10_000,
              })
            : pluginQueryClient.prefetchQuery({
                queryKey: rpc.pullRequest.queryKey(input),
                queryFn: () => client.pullRequest(input),
                staleTime: 15_000,
              });
      void request.finally(() => {
        activePrefetches--;
      });
    }, 120);
  };
}
