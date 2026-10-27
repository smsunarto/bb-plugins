import { eq, inArray, isNull, or, type InitialQueryBuilder } from "@tanstack/react-db";
import {
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  tasksCollection,
} from "../../shell/collections.js";
import { tasksLoadError, useActiveTasks, useTasksLiveQuery } from "../../shell/data.js";
import type { Task, TaskPriority, TaskStatus } from "../../shared/contract.js";
import { matchesFilters } from "./lib.js";

interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  /** Null leaves labels unfiltered; empty matches nothing. */
  labelIds: readonly string[] | null;
}

interface ListScope {
  projectId: string | null;
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

function listQuery(q: InitialQueryBuilder, scope: ListScope) {
  let query = q.from({ task: tasksCollection }).where(({ task }) => isNull(task.parentTaskId));
  const { projectId, statuses, priorities, labelIds } = scope;
  if (projectId !== null) query = query.where(({ task }) => eq(task.projectId, projectId));
  if (statuses.length > 0) query = query.where(({ task }) => inArray(task.status, [...statuses]));
  if (priorities.length > 0) {
    query = query.where(({ task }) => inArray(task.priority, [...priorities]));
  }
  if (labelIds !== null) {
    query = query.where(({ task }) => {
      const [first, second, ...rest] = labelIds.map((labelId) => inArray(labelId, task.labelIds));
      if (first === undefined) return inArray(task.id, []);
      return second === undefined ? first : or(first, second, ...rest);
    });
  }
  return query;
}

export interface ListTasksResult {
  tasks: Task[] | undefined;
  isLoading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The list's top-level tasks. Without a status filter, open tasks load
 * apart from closed ones and paint as soon as they arrive.
 */
export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
): ListTasksResult {
  const split = !activeOnly && filters.statuses.length === 0;
  const scope = (statuses: readonly TaskStatus[]): ListScope => ({
    projectId,
    statuses,
    priorities: filters.priorities,
    labelIds: filters.labelIds,
  });
  const primaryScope = scope(split ? OPEN_TASK_STATUSES : filters.statuses);
  // A key names whether its query runs: a live query rebuilds only when its key changes.
  const primary = useTasksLiveQuery(
    ["list-tasks", "primary", activeOnly ? null : primaryScope],
    (q) => (activeOnly ? undefined : listQuery(q, primaryScope)),
  );
  const closedScope = scope(CLOSED_TASK_STATUSES);
  const closed = useTasksLiveQuery(["list-tasks", "closed", split ? closedScope : null], (q) =>
    split ? listQuery(q, closedScope) : undefined,
  );
  const active = useActiveTasks({ topLevelOnly: true, enabled: activeOnly });

  if (activeOnly) {
    const { labelIds } = filters;
    const tasks = active.data?.filter(
      (task) =>
        (projectId === null || task.projectId === projectId) &&
        labelIds?.length !== 0 &&
        matchesFilters(task, filters.statuses, filters.priorities, labelIds ?? []),
    );
    return {
      tasks,
      isLoading: active.isLoading,
      error: active.error,
      retry: active.retry,
    };
  }
  const failed = primary.isError || (split && closed.isError);
  const retry = () => {
    primary.retry();
    closed.retry();
  };
  if (failed) return { tasks: undefined, isLoading: false, error: tasksLoadError(), retry };
  if (!primary.isReady) return { tasks: undefined, isLoading: true, error: null, retry };
  return {
    tasks: split
      ? [...(primary.data ?? []), ...(closed.isReady ? (closed.data ?? []) : [])]
      : primary.data,
    isLoading: split && !closed.isReady,
    error: null,
    retry,
  };
}
