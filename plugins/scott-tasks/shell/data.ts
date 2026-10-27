import { useCallback, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import {
  inArray,
  isNull,
  useLiveQuery,
  type Context,
  type InitialQueryBuilder,
  type LiveQueryKey,
  type QueryBuilder,
} from "@tanstack/react-db";
import type { TasksRpcContract, TaskThread } from "../shared/contract.js";
import { errorMessage } from "../shared/errors.js";
import type { MentionItem } from "../editor/extensions.js";
import { ACTIVE_THREAD_STATUSES, taskThreadsCollection, tasksCollection } from "./collections.js";
import {
  foldersQuery,
  labelsQuery,
  presetsQuery,
  projectsQuery,
  sidebarSummaryQuery,
  tasksQueryClient,
} from "./query.js";
import { refetchFailedReads } from "./sync.js";
import { useTasksUi } from "./ui-store.js";

export { listAllTasks, OPEN_TASK_STATUSES } from "./collections.js";
export type { TasksRpc } from "./query.js";

export function useTasksRpc() {
  return useRpc<TasksRpcContract>();
}

export const useFolders = () => useQuery(foldersQuery);
export const useProjects = () => useQuery(projectsQuery);
export const usePresets = () => useQuery(presetsQuery);
export const useSidebarSummary = () => useQuery(sidebarSummaryQuery);
export const useLabels = () => useQuery(labelsQuery);

/** The message for a failed read, or null. */
export function queryError(error: unknown): string | null {
  return error === null || error === undefined ? null : errorMessage(error);
}

/**
 * A live query over the Tasks collections. `queryKey` names everything the
 * query closes over, including whether it runs at all. A failed load retries after the next realtime batch,
 * reconnect, or refresh, or when `retry` is called.
 */
export function useTasksLiveQuery<TContext extends Context>(
  queryKey: LiveQueryKey,
  query: (q: InitialQueryBuilder) => QueryBuilder<TContext> | undefined | null,
) {
  const generation = useTasksUi((state) => state.syncGeneration);
  const [attempt, setAttempt] = useState<{ count: number; failedAt: number | null }>({
    count: 0,
    failedAt: null,
  });
  const live = useLiveQuery({ queryKey: [...queryKey, attempt.count], query });
  // A live query stays failed, so the retry is a new one; sync has re-read the failed subsets.
  if (live.isError && attempt.failedAt === null) {
    setAttempt({ count: attempt.count, failedAt: generation });
  } else if (live.isError && attempt.failedAt !== generation) {
    setAttempt({ count: attempt.count + 1, failedAt: null });
  }
  const retry = useCallback(() => {
    refetchFailedReads();
    setAttempt((current) => ({ count: current.count + 1, failedAt: null }));
  }, []);
  return { ...live, retry };
}

/**
 * Why a tasks read failed, for a failed live query's message. Each subset is
 * its own Query, so a later success elsewhere leaves this one's error intact.
 */
export function tasksLoadError(collectionKey: QueryKey = ["tasks"]): string {
  const [failed] = tasksQueryClient
    .getQueryCache()
    .findAll({
      queryKey: collectionKey,
      type: "active",
      predicate: (query) => query.state.status === "error",
    })
    .sort((a, b) => b.state.errorUpdatedAt - a.state.errorUpdatedAt);
  return failed === undefined ? "Tasks are unavailable" : errorMessage(failed.state.error);
}

function useActiveThreadLinks() {
  const links = useTasksLiveQuery(["active-task-threads"], (q) =>
    q
      .from({ link: taskThreadsCollection })
      .where(({ link }) => inArray(link.liveStatus, [...ACTIVE_THREAD_STATUSES])),
  );
  const byTaskId = useMemo(() => {
    const grouped = new Map<string, TaskThread[]>();
    for (const link of links.data ?? []) {
      const taskLinks = grouped.get(link.taskId);
      if (taskLinks) taskLinks.push(link);
      else grouped.set(link.taskId, [link]);
    }
    return grouped;
  }, [links.data]);
  return { links, byTaskId };
}

/** Every task's live agent threads, grouped by task. */
export function useActiveThreads(): ReadonlyMap<string, TaskThread[]> {
  return useActiveThreadLinks().byTaskId;
}

/** Tasks with a live agent thread; `topLevelOnly` leaves out sub-tasks. */
export function useActiveTasks({
  topLevelOnly = false,
  enabled = true,
}: { topLevelOnly?: boolean; enabled?: boolean } = {}) {
  const { links, byTaskId } = useActiveThreadLinks();
  const taskIds = useMemo(() => [...byTaskId.keys()].sort(), [byTaskId]);
  const runs = enabled && links.isReady;
  const tasks = useTasksLiveQuery(["active-tasks", topLevelOnly, runs ? taskIds : null], (q) => {
    if (!runs) return undefined;
    const active = q.from({ task: tasksCollection }).where(({ task }) => inArray(task.id, taskIds));
    return topLevelOnly ? active.where(({ task }) => isNull(task.parentTaskId)) : active;
  });
  const ready = links.isReady && tasks.isReady;
  const failed = links.isError || tasks.isError;
  return {
    data: ready ? tasks.data : undefined,
    error: failed ? tasksLoadError(links.isError ? ["taskThreads"] : ["tasks"]) : null,
    isLoading: !failed && !ready,
    retry: () => {
      links.retry();
      tasks.retry();
    },
  };
}

export function useMentionItems() {
  const rpc = useTasksRpc();
  return useCallback(
    async (query: string): Promise<MentionItem[]> => {
      const trimmed = query.trim();
      const [taskResult, threadResult] = await Promise.all([
        rpc.call("listTasks", {
          ...(trimmed ? { search: trimmed } : {}),
          limit: 8,
        }),
        rpc.call("searchThreads", { query: trimmed, limit: 5 }).catch(() => ({ threads: [] })),
      ]);
      return [
        ...taskResult.tasks.slice(0, 8).map((task) => ({
          type: "task" as const,
          id: task.id,
          key: task.key,
          title: task.title,
        })),
        ...threadResult.threads.map((thread) => ({
          type: "thread" as const,
          id: thread.id,
          title: thread.title,
        })),
      ];
    },
    [rpc],
  );
}
