import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Label, Task } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { editTask, type TaskEdit } from "../../shell/collections.js";
import { useActiveThreads, useLabels, useProjects } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { useTasksUi } from "../../shell/ui-store.js";
import { DetailToasts, useDetailToasts } from "../detail/toast.js";
import { EmptyState } from "../../components/empty-state.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useListTasks } from "./data.js";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  ListFilterBar,
  type ListFilterState,
} from "./filter-bar.js";
import {
  listPreferenceScope,
  loadListPreference,
  storeListPreference,
  type ListPreference,
} from "./list-preference.js";
import { sortTasks } from "../../shared/sort.js";
import type { TaskSort } from "../../shared/pagination.js";
import { StatusIcon } from "./icons.js";
import { listScrollScopeKey, useListScrollRestoration } from "./scroll-restoration.js";
import { groupTasksByStatus, labelFilterOptions, selectedLabelIds, STATUS_LABELS } from "./lib.js";
import { TaskRow } from "./row.js";
import { rowWindows, useRowWindowViewport } from "./row-window.js";

const NO_LABELS: readonly Label[] = [];
const NO_TASKS: readonly Task[] = [];

/** A row with an optimistic edit the server has not confirmed yet. */
function hasPendingWrites(task: Task): boolean {
  return (task as { $hasPendingWrites?: boolean }).$hasPendingWrites === true;
}

interface ListViewProps {
  projectId: string | null;
  activeOnly?: boolean;
}

function LoadingRows() {
  return (
    <DelayedLoading>
      <div className="px-3.5 pt-3">
        <Skeleton className="mb-3 h-4 w-28" />
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
          >
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

export function ListView({ projectId, activeOnly = false }: ListViewProps) {
  const navigation = useTasksNavigation();
  const openTask = useCallback(
    (taskKey: string) => navigation.go({ kind: "task", taskKey }),
    [navigation],
  );
  const projects = useProjects();
  const { toasts, push, dismiss } = useDetailToasts();
  const preferenceScope = listPreferenceScope(projectId, activeOnly);
  const [preference, setPreference] = useState<ListPreference>(() =>
    loadListPreference(preferenceScope),
  );
  useEffect(() => {
    setPreference(loadListPreference(preferenceScope));
  }, [preferenceScope]);
  const filters = preference.filters;
  const sort = preference.sort;
  const setFilters = (next: ListFilterState) => {
    setPreference((current) => {
      const updated: ListPreference = { filters: next, sort: current.sort };
      storeListPreference(preferenceScope, updated);
      return updated;
    });
  };
  const setSort = (next: TaskSort) => {
    setPreference((current) => {
      const updated: ListPreference = { filters: current.filters, sort: next };
      storeListPreference(preferenceScope, updated);
      return updated;
    });
  };
  const openNewTask = useTasksUi((state) => state.openNewTask);

  const allLabels = useLabels();
  const labels = useMemo(
    () =>
      allLabels.data === undefined || projectId === null
        ? allLabels.data
        : allLabels.data.filter((label) => label.projectId === projectId),
    [allLabels.data, projectId],
  );
  const labelOptions = useMemo(() => labelFilterOptions(labels ?? []), [labels]);
  const labelIds = useMemo((): readonly string[] | null => {
    if (filters.labelNames.length === 0) return null;
    if (labels === undefined) return null;
    return selectedLabelIds(labelOptions, filters.labelNames);
  }, [filters.labelNames, labelOptions, labels]);

  const tasksQuery = useListTasks(projectId, activeOnly, {
    statuses: filters.statuses,
    priorities: filters.priorities,
    labelIds,
  });
  const activeThreads = useActiveThreads();
  const onEdit = useCallback(
    (task: Task, patch: TaskEdit) => {
      editTask(task.id, patch).catch((error: unknown) => push(errorMessage(error)));
    },
    [push],
  );

  const labelsById = useMemo(
    () => new Map((labels ?? []).map((label) => [label.id, label])),
    [labels],
  );
  const labelsByProject = useMemo(() => {
    const map = new Map<string, Label[]>();
    for (const label of labels ?? []) {
      const bucket = map.get(label.projectId);
      if (bucket) bucket.push(label);
      else map.set(label.projectId, [label]);
    }
    return map;
  }, [labels]);
  const projectsById = useMemo(
    () => new Map((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );

  const tasks = tasksQuery.phase === "ready" ? tasksQuery.tasks : NO_TASKS;
  const groups = useMemo(() => groupTasksByStatus(sortTasks(tasks, sort)), [tasks, sort]);

  const showProject = projectId === null;
  const filtered = hasActiveFilters(filters);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeKey = listScrollScopeKey({ projectId, activeOnly, filters, sort });
  const settledScope = useRef(scopeKey);
  const scopeChanged = settledScope.current !== scopeKey;
  // Rows are still arriving while the primary query loads or the closed split trails it.
  const loading =
    tasksQuery.phase === "loading" || (tasksQuery.phase === "ready" && tasksQuery.closedPending);
  useEffect(() => {
    if (!loading) settledScope.current = scopeKey;
  }, [scopeKey, loading, tasks]);
  useListScrollRestoration(scrollRef, scopeKey, {
    contentReady: tasks.length > 0,
    loading: loading || scopeChanged,
    revision: tasks.length,
  });

  const viewport = useRowWindowViewport(scrollRef, groups);
  const ranges = rowWindows({
    counts: groups.map((group) => group.tasks.length),
    headerHeight: viewport.headerHeight,
    rowHeight: viewport.rowHeight,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
  });

  let body: React.ReactNode;
  if (tasksQuery.phase === "failed") {
    body = (
      <EmptyState icon="AlertCircle" title="Couldn't load tasks" description={tasksQuery.error} />
    );
  } else if (tasksQuery.phase === "loading") {
    body = <LoadingRows />;
  } else if (tasks.length === 0) {
    if (filtered) {
      body = (
        <EmptyState
          icon="Search"
          title="No tasks match these filters"
          action={
            <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      );
    } else if (activeOnly) {
      body = (
        <EmptyState
          icon="Zap"
          title="No agents working right now"
          description="Dispatch a task to an agent preset and it will show up here while it runs."
        />
      );
    } else {
      body = (
        <EmptyState
          icon="ListTodo"
          title="No tasks yet"
          description="Create the first task to start tracking work."
          action={
            <Button size="sm" onClick={() => openNewTask({ projectId })}>
              <Icon name="Plus" className="size-3.5" />
              New task
            </Button>
          }
        />
      );
    }
  } else {
    body = groups.map((group, groupIndex) => {
      const [start, end] = ranges[groupIndex] ?? [0, group.tasks.length];
      const hiddenAbove = start * viewport.rowHeight;
      const hiddenBelow = (group.tasks.length - end) * viewport.rowHeight;
      return (
        <section key={group.status}>
          <div
            data-status-group-header={group.status}
            className="sticky top-0 z-20 isolate flex items-center gap-2 border-b border-border-hairline bg-background px-3.5 pb-1.5 pt-2.5 text-sm font-semibold"
          >
            <StatusIcon status={group.status} />
            {STATUS_LABELS[group.status]}
            <span className="text-xs font-normal tabular-nums text-subtle-foreground">
              {group.tasks.length}
            </span>
          </div>
          {hiddenAbove > 0 ? <div aria-hidden style={{ height: hiddenAbove }} /> : null}
          {group.tasks.slice(start, end).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              activeThreads={activeThreads.get(task.id)}
              project={projectsById.get(task.projectId)}
              showProject={showProject}
              labelsById={labelsById}
              projectLabels={labelsByProject.get(task.projectId) ?? NO_LABELS}
              onEdit={onEdit}
              onOpen={openTask}
              pending={hasPendingWrites(task)}
            />
          ))}
          {hiddenBelow > 0 ? <div aria-hidden style={{ height: hiddenBelow }} /> : null}
        </section>
      );
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        filters={filters}
        onChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        labelOptions={labelOptions}
        taskCount={tasksQuery.phase === "ready" ? tasksQuery.tasks.length : undefined}
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto @container">
        {body}
      </div>
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
