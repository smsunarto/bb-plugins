import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtimeConnectionState,
  useSdk,
  type PluginBrowserBbSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

type WorkerList = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>;

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);
/** Plugins whose workers run hidden under the thread that launched them. */
const WORKER_PLUGINS = ["review", "scott-engineering"];
const WORKER_CHANGES = new Set([
  "thread-created",
  "parent-changed",
  "status-changed",
  "archived-changed",
  "thread-deleted",
]);

/** How long a burst of worker changes waits for quiet before one lookup. */
const BURST_DEBOUNCE_MS = 250;
/** The longest a steady stream of changes holds its lookup back. */
const BURST_MAX_WAIT_MS = 1000;

/** Running hidden workers per owning thread, across every worker plugin's list. */
function runningByOwner(lists: readonly WorkerList[]): Map<string, number> {
  const running = new Map<string, number>();
  const workers = new Map(lists.flat().map((worker) => [worker.id, worker]));
  for (const worker of workers.values()) {
    const owner = worker.parentThreadId ?? worker.lifecycleOwnerThreadId;
    if (owner && worker.visibility === "hidden" && RUNNING.has(worker.status)) {
      running.set(owner, (running.get(owner) ?? 0) + 1);
    }
  }
  return running;
}

/**
 * Hidden Review and Arena workers are absent from the sidebar roster; the
 * thread that launched them still has live work. Reviewers are children of
 * that thread, while Arena workers only follow its lifecycle.
 */
export function useHiddenWorkerActivity(
  threads: readonly PluginSidebarThread[],
): readonly PluginSidebarThread[] {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const refreshRef = useRef<(() => void) | null>(null);
  const previousConnection = useRef(connection);
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup aborts the lookup, clears the nested retry timer, and unsubscribes; covered by the unmount test.
  useEffect(() => {
    // One lookup at a time. A change during it marks the lookup dirty, and a
    // follow-up starts when it lands, so every finished lookup is the newest
    // and always applies.
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // When the current burst of changes began; a steady stream still reads
    // within `BURST_MAX_WAIT_MS` of its first change.
    let burstStartedAt: number | undefined;
    let retryDelay = 1000;
    const controller = new AbortController();
    const refresh = async () => {
      clearTimeout(timer);
      burstStartedAt = undefined;
      inFlight = true;
      dirty = false;
      try {
        const results = await Promise.allSettled(
          WORKER_PLUGINS.map((originPluginId) =>
            sdk.threads.list({
              originPluginId,
              includeHidden: true,
              archived: false,
              signal: controller.signal,
            }),
          ),
        );
        if (controller.signal.aborted) return;
        const next = runningByOwner(
          results.map((result) => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
          }),
        );
        retryDelay = 1000;
        setCounts((current) =>
          current.size === next.size && [...next].every(([id, count]) => current.get(id) === count)
            ? current
            : next,
        );
      } catch {
        // Preserve known running work through a failed read; a retry or reconnect reconciles it.
        if (controller.signal.aborted || dirty) return;
        timer = setTimeout(() => void refresh(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && dirty) schedule();
      }
    };
    const schedule = () => {
      if (inFlight) {
        dirty = true;
        return;
      }
      const now = Date.now();
      burstStartedAt ??= now;
      clearTimeout(timer);
      timer = setTimeout(
        () => void refresh(),
        Math.max(0, Math.min(BURST_DEBOUNCE_MS, burstStartedAt + BURST_MAX_WAIT_MS - now)),
      );
    };
    refreshRef.current = schedule;
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.changes.some((change) => WORKER_CHANGES.has(change))) schedule();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      if (refreshRef.current === schedule) refreshRef.current = null;
    };
  }, [sdk]);

  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (previous !== "connected" && connection === "connected") refreshRef.current?.();
  }, [connection]);

  return useMemo(
    () =>
      threads.map((thread) => {
        const workers = counts.get(thread.id) ?? 0;
        if (workers === 0) return thread;
        return {
          ...thread,
          activity: {
            ...thread.activity,
            backgroundAgents: thread.activity.backgroundAgents + workers,
          },
        };
      }),
    [threads, counts],
  );
}
