import { useMemo } from "react";
import { eq, inArray, type InitialQueryBuilder } from "@tanstack/react-db";
import {
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  tasksCollection,
} from "../../shell/collections.js";
import {
  tasksLoadError,
  useActiveTasks,
  useTasksLiveQuery,
  type ListTasks,
} from "../../shell/data.js";
import type { Task, TaskStatus } from "../../shared/contract.js";

function listQuery(
  q: InitialQueryBuilder,
  projectId: string | null,
  statuses: readonly TaskStatus[],
) {
  let query = q.from({ task: tasksCollection });
  if (projectId !== null) query = query.where(({ task }) => eq(task.projectId, projectId));
  return query.where(({ task }) => inArray(task.status, [...statuses]));
}

function mergeById(...lists: readonly (readonly Task[] | undefined)[]): Task[] {
  const byId = new Map<string, Task>();
  for (const list of lists) {
    for (const task of list ?? []) byId.set(task.id, task);
  }
  return [...byId.values()];
}

export type ListTasksResult = (
  | { phase: "loading" }
  | { phase: "failed"; error: string }
  | {
      phase: "ready";
      tasks: Task[];
      activeIds: ReadonlySet<string> | null;
      closedPending: boolean;
    }
) & { retry: () => void };

/**
 * Every task and sub-task in the list's project scope. Open tasks load apart
 * from closed ones and paint as soon as they arrive, with `closedPending` set
 * until the closed ones do. Active views read active task links first and load
 * the scope's open/closed rows only when an active sub-task needs its parent
 * and sibling progress.
 */
export function useListTasks(projectId: string | null, activeOnly: boolean): ListTasksResult {
  const active: ListTasks & { retry: () => void } = useActiveTasks({
    topLevelOnly: false,
    enabled: activeOnly,
  });

  const activeInScope = useMemo(() => {
    if (!activeOnly || active.phase !== "ready") return undefined;
    return projectId === null
      ? active.tasks
      : active.tasks.filter((task) => task.projectId === projectId);
  }, [activeOnly, active, projectId]);

  const loadScope =
    !activeOnly || (activeInScope?.some((task) => task.parentTaskId !== null) ?? false);

  const open = useTasksLiveQuery(["list-tasks", "open", loadScope ? projectId : false], (q) =>
    loadScope ? listQuery(q, projectId, OPEN_TASK_STATUSES) : undefined,
  );
  const closed = useTasksLiveQuery(["list-tasks", "closed", loadScope ? projectId : false], (q) =>
    loadScope ? listQuery(q, projectId, CLOSED_TASK_STATUSES) : undefined,
  );

  const activeIds = useMemo(
    (): ReadonlySet<string> | null =>
      activeInScope === undefined ? null : new Set(activeInScope.map((task) => task.id)),
    [activeInScope],
  );

  const openData = loadScope && open.isReady ? open.data : undefined;
  const closedData = loadScope && closed.isReady ? closed.data : undefined;
  const tasks = useMemo(() => {
    if (activeOnly && activeInScope === undefined) return undefined;
    if (loadScope && openData === undefined) return undefined;
    return mergeById(openData, closedData, activeInScope);
  }, [activeOnly, activeInScope, loadScope, openData, closedData]);

  const retry = () => {
    if (loadScope) {
      open.retry();
      closed.retry();
    }
    if (activeOnly) active.retry();
  };

  if (activeOnly && active.phase === "failed") {
    return { phase: "failed", error: active.error, retry };
  }
  if (loadScope && (open.isError || closed.isError)) {
    return { phase: "failed", error: tasksLoadError(), retry };
  }
  if (tasks === undefined) {
    return { phase: "loading", retry };
  }
  return {
    phase: "ready",
    tasks,
    activeIds,
    closedPending: loadScope && !closed.isReady,
    retry,
  };
}
