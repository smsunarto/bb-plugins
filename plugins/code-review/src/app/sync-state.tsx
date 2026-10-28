import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { queryClient } from "./query.ts";
import type { InboxPr } from "../shared/schema.ts";
import { absoluteTime, relativeTime } from "./format.ts";
import { errorText } from "./notice.tsx";
import { queryKey, useCodeReviewRpc } from "./rpc.ts";
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

/** The page's oldest data and one refresh action; each section reports its own failure. */
export function pageSync(own: SyncQuery, parts: readonly SyncQuery[]): SyncQuery {
  const sources = [own, ...parts];
  const stamps = sources.map((query) => query.dataUpdatedAt).filter((stamp) => stamp > 0);
  return {
    dataUpdatedAt: stamps.length ? Math.min(...stamps) : 0,
    isFetching: sources.some((query) => query.isFetching),
    isError: own.isError,
    error: own.error,
    refetch: () => Promise.all(sources.map((query) => query.refetch())),
  };
}

/** How often "Updated 2m ago" moves on. */
const TICK_MS = 30_000;

export function useNow(): number {
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
      for (const method of [
        ...LOCAL_READS,
        "localBranches",
        "localBranch",
        "sharedComparison",
        "localChanges",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [method] }, { cancelRefetch: false });
      }
    }
    previous.current = state;
  }, [state]);
}

// Prefetch has a global concurrency cap, so moving across many rows cannot flood gh.
let activePrefetches = 0;
/** A short hover/focus dwell, a two-read cap, and TanStack deduplication bound speculative work. */
export function usePrPrefetch() {
  const client = useCodeReviewRpc();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (pr: Pick<InboxPr, "account" | "ref">) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (activePrefetches >= 2) return;
      activePrefetches++;
      const input = { account: pr.account, ref: pr.ref };
      const request = queryClient.prefetchQuery({
        queryKey: queryKey("pullRequest", input),
        queryFn: () => client.call("pullRequest", input),
        staleTime: 15_000,
      });
      void request.finally(() => {
        activePrefetches--;
      });
    }, 120);
  };
}
