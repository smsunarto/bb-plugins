import { useEffect, useMemo, useState } from "react";
import {
  useRealtimeConnectionState,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

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
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup aborts the lookup, clears the nested retry timer, and unsubscribes; covered by the unmount test.
  useEffect(() => {
    let revision = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    const controller = new AbortController();
    const refresh = async () => {
      clearTimeout(retry);
      const request = ++revision;
      try {
        const lists = await Promise.all(
          WORKER_PLUGINS.map((originPluginId) =>
            sdk.threads.list({
              originPluginId,
              includeHidden: true,
              archived: false,
              signal: controller.signal,
            }),
          ),
        );
        if (controller.signal.aborted || request !== revision) return;
        const next = new Map<string, number>();
        const workers = new Map(lists.flat().map((worker) => [worker.id, worker]));
        for (const worker of workers.values()) {
          const owner = worker.parentThreadId ?? worker.lifecycleOwnerThreadId;
          if (owner && worker.visibility === "hidden" && RUNNING.has(worker.status)) {
            next.set(owner, (next.get(owner) ?? 0) + 1);
          }
        }
        retryDelay = 1000;
        setCounts((current) =>
          current.size === next.size && [...next].every(([id, count]) => current.get(id) === count)
            ? current
            : next,
        );
      } catch {
        if (controller.signal.aborted || request !== revision) return;
        // Preserve known running work through a failed read; a retry or reconnect reconciles it.
        retry = setTimeout(() => void refresh(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.changes.some((change) => WORKER_CHANGES.has(change))) void refresh();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(retry);
      unsubscribe();
    };
  }, [sdk, connection]);

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
