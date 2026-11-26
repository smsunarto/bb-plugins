import { useMemo } from "react";
import { eq, inArray, type InitialQueryBuilder } from "@tanstack/react-db";
import {
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  tasksCollection,
} from "../../shell/collections.js";
import { tasksLoadError, useActiveTasks, useTasksLiveQuery } from "../../shell/data.js";
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

const EMPTY_IDS: readonly string[] = [];

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
 * until the closed ones do. Active views read only active tasks, any missing
 * parents of active sub-tasks, and sub-tasks of those parents so progress pills
 * work without scanning unrelated projects.
 */
export function useListTasks(projectId: string | null, activeOnly: boolean): ListTasksResult {
  const active = useActiveTasks({ enabled: activeOnly });
  const activeTasks = activeOnly && active.phase === "ready" ? active.tasks : undefined;

  const activeInScope = useMemo(() => {
    if (activeTasks === undefined) return undefined;
    return projectId === null
      ? activeTasks
      : activeTasks.filter((task) => task.projectId === projectId);
  }, [activeTasks, projectId]);

  const activeIds = useMemo(
    (): ReadonlySet<string> | null =>
      activeInScope === undefined ? null : new Set(activeInScope.map((task) => task.id)),
    [activeInScope],
  );

  const missingParentIds = useMemo(() => {
    if (activeInScope === undefined || activeIds === null) return EMPTY_IDS;
    const ids = new Set<string>();
    for (const task of activeInScope) {
      if (task.parentTaskId !== null && !activeIds.has(task.parentTaskId)) {
        ids.add(task.parentTaskId);
      }
    }
    return ids.size === 0 ? EMPTY_IDS : [...ids].sort();
  }, [activeInScope, activeIds]);

  const parentIdsForSubTasks = useMemo(() => {
    if (activeInScope === undefined || activeInScope.length === 0) return EMPTY_IDS;
    const ids = new Set<string>();
    for (const task of activeInScope) {
      ids.add(task.parentTaskId ?? task.id);
    }
    return [...ids].sort();
  }, [activeInScope]);

  const loadScope = !activeOnly;

  const open = useTasksLiveQuery(["list-tasks", "open", loadScope ? projectId : false], (q) =>
    loadScope ? listQuery(q, projectId, OPEN_TASK_STATUSES) : undefined,
  );
  const closed = useTasksLiveQuery(["list-tasks", "closed", loadScope ? projectId : false], (q) =>
    loadScope ? listQuery(q, projectId, CLOSED_TASK_STATUSES) : undefined,
  );
  const activeParents = useTasksLiveQuery(
    ["list-tasks", "active-parents", missingParentIds.length > 0 ? missingParentIds : false],
    (q) =>
      missingParentIds.length > 0
        ? q
            .from({ task: tasksCollection })
            .where(({ task }) => inArray(task.id, [...missingParentIds]))
        : undefined,
  );
  const activeSubTasks = useTasksLiveQuery(
    [
      "list-tasks",
      "active-subtasks",
      parentIdsForSubTasks.length > 0 ? parentIdsForSubTasks : false,
    ],
    (q) =>
      parentIdsForSubTasks.length > 0
        ? q
            .from({ task: tasksCollection })
            .where(({ task }) => inArray(task.parentTaskId, [...parentIdsForSubTasks]))
        : undefined,
  );

  const openData = loadScope && open.isReady ? open.data : undefined;
  const closedData = loadScope && closed.isReady ? closed.data : undefined;
  const parentData =
    missingParentIds.length > 0 && activeParents.isReady ? activeParents.data : undefined;
  const subTaskData =
    parentIdsForSubTasks.length > 0 && activeSubTasks.isReady ? activeSubTasks.data : undefined;

  const tasks = useMemo(() => {
    if (activeOnly) {
      if (activeInScope === undefined) return undefined;
      return mergeById(activeInScope, parentData, subTaskData);
    }
    if (openData === undefined) return undefined;
    return mergeById(openData, closedData);
  }, [activeOnly, activeInScope, parentData, subTaskData, openData, closedData]);

  const retry = () => {
    if (loadScope) {
      open.retry();
      closed.retry();
    }
    if (activeOnly) {
      active.retry();
      if (missingParentIds.length > 0) activeParents.retry();
      if (parentIdsForSubTasks.length > 0) activeSubTasks.retry();
    }
  };

  if (activeOnly && active.phase === "failed") {
    return { phase: "failed", error: active.error, retry };
  }
  if (activeOnly && missingParentIds.length > 0 && activeParents.isError) {
    return { phase: "failed", error: tasksLoadError(), retry };
  }
  if (loadScope && (open.isError || closed.isError)) {
    return { phase: "failed", error: tasksLoadError(), retry };
  }
  if (tasks === undefined) {
    return { phase: "loading", retry };
  }
  const parentsPending = activeOnly && missingParentIds.length > 0 && !activeParents.isReady;
  return {
    phase: "ready",
    tasks,
    activeIds,
    closedPending: (loadScope && !closed.isReady) || parentsPending,
    retry,
  };
}
