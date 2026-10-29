import { eq, inArray, isNull, or, type InitialQueryBuilder } from "@tanstack/react-db";
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
import type { TaskPriority, TaskStatus } from "../../shared/contract.js";
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

/**
 * The list's top-level tasks. Without a status filter, open tasks load
 * apart from closed ones and paint as soon as they arrive, with
 * `closedPending` set until the closed ones do.
 */
export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
): ListTasks & { retry: () => void } {
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
    if (active.phase !== "ready") return active;
    const { labelIds } = filters;
    return {
      ...active,
      tasks: active.tasks.filter(
        (task) =>
          (projectId === null || task.projectId === projectId) &&
          labelIds?.length !== 0 &&
          matchesFilters(task, filters.statuses, filters.priorities, labelIds ?? []),
      ),
    };
  }
  const retry = () => {
    primary.retry();
    closed.retry();
  };
  if (primary.isError || (split && closed.isError)) {
    return { phase: "failed", error: tasksLoadError(), retry };
  }
  if (!primary.isReady) return { phase: "loading", retry };
  return {
    phase: "ready",
    tasks: split
      ? [...(primary.data ?? []), ...(closed.isReady ? (closed.data ?? []) : [])]
      : (primary.data ?? []),
    closedPending: split && !closed.isReady,
    retry,
  };
}
