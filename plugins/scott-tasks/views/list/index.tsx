import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { replaceEqualDeep } from "@tanstack/react-query";
import {
  TASK_STATUSES,
  type Label,
  type Project,
  type Task,
  type TaskStatus,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { editTask, tasksCollection, type TaskEdit } from "../../shell/collections.js";
import { useActiveThreads, useLabels, useProjects, useTasksRpc } from "../../shell/data.js";
import type { TaskScope } from "../../shell/routes.js";
import { useTasksUi } from "../../shell/ui-store.js";
import { hasOpenOverlay } from "../../shell/keyboard.js";
import { ViewEmptyState } from "../../components/empty-state.js";
import { Badge } from "@/components/ui/badge";
import { Button, CompactButton } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Item, ItemGroup } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isImeComposing, isNonImeKey } from "@/lib/ime-keyboard";
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
import {
  captureListAnchor,
  listScrollScopeKey,
  resolveListAnchor,
  useListScrollRestoration,
  type CollapsedGroups,
  type ListScrollAnchor,
} from "./scroll-restoration.js";
import {
  childrenByParent,
  childrenForList,
  displayRows,
  groupTasksByStatus,
  labelFilterOptions,
  listTaskCount,
  parentIsOpen,
  selectedLabelIds,
  STATUS_LABELS,
  taskMatches,
  widestKeysByPrefix,
  type TaskMatchCriteria,
} from "./lib.js";
import { KeyColumnScope, TaskRow } from "./row.js";
import { rowWindows, useRowWindowViewport } from "./row-window.js";
import { isBareKey } from "./property-menus.js";

const NO_LABELS: readonly Label[] = [];
const NO_TASKS: readonly Task[] = [];
const NO_PROJECTS: readonly Project[] = [];
const BULK_STATUS_CONCURRENCY = 4;

/** A row with an optimistic edit the server has not confirmed yet. */
function hasPendingWrites(task: Task): boolean {
  return (task as { $hasPendingWrites?: boolean }).$hasPendingWrites === true;
}

export interface ListResume {
  scopeKey: string;
  collapsed: CollapsedGroups;
  selection: ReadonlySet<string>;
  orderedRows: readonly Pick<Task, "id" | "key">[];
  openedId: string;
  anchor: ListScrollAnchor | null;
}

interface ListViewProps {
  projectId: string | null;
  scope?: TaskScope;
  resume: ListResume | null;
  onOpenTask: (taskKey: string, resume: ListResume) => void;
  onError: (message: string) => void;
}

interface FlatRow {
  task: Task;
  child: boolean;
  open: boolean;
}

function readRow(container: HTMLElement, key: string) {
  return container.querySelector<HTMLButtonElement>(`[data-open-task="${key}"]`);
}

function LoadingRows() {
  return (
    <DelayedLoading>
      <div className="px-4 pt-3">
        <Skeleton className="mb-3 h-4 w-28" />
        <ItemGroup variant="flush" role="none">
          {Array.from({ length: 7 }, (_, index) => (
            <Item key={index} size="row" className="h-9">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="h-3 w-3/5" />
            </Item>
          ))}
        </ItemGroup>
      </div>
    </DelayedLoading>
  );
}

export function ListView({ projectId, scope, resume, onOpenTask, onError: push }: ListViewProps) {
  const activeOnly = scope === "active";
  const backlogOnly = scope === "backlog";
  const projects = useProjects();
  const preferenceScope = listPreferenceScope(projectId, scope);
  // Each scope keeps its own saved preference, read again when the scope changes.
  const [stored, setStored] = useState(() => ({
    scope: preferenceScope,
    preference: loadListPreference(preferenceScope),
  }));
  const [search, setSearch] = useState("");
  const { filters, sort, expandedTaskIds: expanded } = stored.preference;
  const statuses: TaskStatus[] = useMemo(
    () => (backlogOnly ? ["backlog"] : filters.statuses),
    [backlogOnly, filters.statuses],
  );
  const scopeKey = listScrollScopeKey({
    projectId,
    activeOnly,
    backlogOnly,
    filters: { ...filters, statuses },
    sort,
    search,
  });
  const [selection, setSelection] = useState<ReadonlySet<string>>(() =>
    resume?.scopeKey === scopeKey ? resume.selection : new Set(),
  );
  const [collapsed, setCollapsed] = useState<CollapsedGroups>(() => resume?.collapsed ?? {});
  if (stored.scope !== preferenceScope) {
    setStored({ scope: preferenceScope, preference: loadListPreference(preferenceScope) });
    setSearch("");
    setSelection(new Set());
    setCollapsed({});
  }
  const updatePreference = useCallback(
    (update: (current: ListPreference) => ListPreference) => {
      setStored((current) => {
        const updated = update(current.preference);
        storeListPreference(preferenceScope, updated);
        return { scope: current.scope, preference: updated };
      });
    },
    [preferenceScope],
  );
  const setFilters = (next: ListFilterState) => {
    setSelection(new Set());
    updatePreference((current) => ({
      ...current,
      filters: backlogOnly ? { ...next, statuses: current.filters.statuses } : next,
    }));
  };
  const setSort = (next: TaskSort) => {
    updatePreference((current) => ({ ...current, sort: next }));
  };
  const toggleSubTasks = useCallback(
    (taskId: string) =>
      updatePreference((current) => ({
        ...current,
        expandedTaskIds: current.expandedTaskIds.includes(taskId)
          ? current.expandedTaskIds.filter((id) => id !== taskId)
          : [...current.expandedTaskIds, taskId],
      })),
    [updatePreference],
  );
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

  const visibleFilters = backlogOnly ? { ...filters, statuses: [] } : filters;
  const tasksQuery = useListTasks(projectId, activeOnly);
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
  const rpc = useTasksRpc();
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  });
  // Stable so memoized rows skip re-rendering; the moved task's new key arrives through sync.
  const moveToProject = useCallback(
    (task: Task, targetProjectId: string) => {
      rpcRef.current
        .call("moveTaskToProject", { taskId: task.id, projectId: targetProjectId })
        .then(
          (result) => {
            if (!result.ok) push(result.error.message);
          },
          (error: unknown) => push(errorMessage(error)),
        );
    },
    [push],
  );
  const projectList = projects.data ?? NO_PROJECTS;
  const projectsById = useMemo(
    () => new Map(projectList.map((project) => [project.id, project])),
    [projectList],
  );

  const loadedTasks = tasksQuery.phase === "ready" ? tasksQuery.tasks : NO_TASKS;
  const activeIds = tasksQuery.phase === "ready" ? tasksQuery.activeIds : null;
  const topLevelTasks = useMemo(
    () => loadedTasks.filter((task) => task.parentTaskId === null),
    [loadedTasks],
  );
  const allChildrenByParent = useMemo(() => childrenByParent(loadedTasks), [loadedTasks]);
  const matchCriteria = useMemo(
    (): TaskMatchCriteria => ({
      statuses,
      priorities: filters.priorities,
      labelIds,
      search,
      activeIds,
    }),
    [statuses, filters.priorities, labelIds, search, activeIds],
  );
  const { visible: visibleChildren, totals: childTotals } = useMemo(
    () => childrenForList(allChildrenByParent, matchCriteria, sort),
    [allChildrenByParent, matchCriteria, sort],
  );
  const displayTasks = useMemo(
    () => displayRows(topLevelTasks, matchCriteria, visibleChildren),
    [topLevelTasks, matchCriteria, visibleChildren],
  );
  const taskCount = useMemo(
    () =>
      tasksQuery.phase === "ready"
        ? listTaskCount(displayTasks, matchCriteria, visibleChildren)
        : undefined,
    [tasksQuery.phase, displayTasks, matchCriteria, visibleChildren],
  );
  const widestKeys = useMemo(() => widestKeysByPrefix(loadedTasks), [loadedTasks]);
  const groups = useMemo(
    () =>
      groupTasksByStatus(sortTasks(displayTasks, sort)).map((group) => {
        const rows: FlatRow[] = [];
        for (const task of group.tasks) {
          const open = parentIsOpen(task.id, expanded, matchCriteria, visibleChildren);
          rows.push({ task, child: false, open });
          if (!open) continue;
          for (const child of visibleChildren.get(task.id) ?? []) {
            rows.push({ task: child, child: true, open: false });
          }
        }
        return { status: group.status, count: group.tasks.length, rows };
      }),
    [displayTasks, sort, expanded, matchCriteria, visibleChildren],
  );
  const groupId = useId();
  const orderedTasks = useMemo(
    () => groups.flatMap(({ status, rows }) => (collapsed[status] ? [] : rows.map((r) => r.task))),
    [collapsed, groups],
  );
  const openTaskRef = useRef<(taskKey: string) => void>(() => {});
  const openTask = useCallback((taskKey: string) => openTaskRef.current(taskKey), []);
  const selectedTasks = useMemo(
    () => loadedTasks.filter((task) => selection.has(task.id)),
    [selection, loadedTasks],
  );
  const bulkStatusPending = useTasksUi((state) => state.bulkStatusPending);
  const setBulkStatus = async (status: TaskStatus) => {
    if (useTasksUi.getState().bulkStatusPending) return;
    const queue = selectedTasks
      .map((task) => tasksCollection.get(task.id) ?? task)
      .filter((task) => task.status !== status)
      .values();
    useTasksUi.setState({ bulkStatusPending: true });
    setSelection(new Set());
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(BULK_STATUS_CONCURRENCY, selectedTasks.length) },
          async () => {
            for (const task of queue) {
              try {
                const latest = tasksCollection.get(task.id);
                if (
                  latest &&
                  (hasPendingWrites(latest) || replaceEqualDeep(task, latest) !== task)
                ) {
                  push(`${task.key}: Skipped because the task changed`);
                  continue;
                }
                await editTask(task.id, { status });
              } catch (error) {
                push(`${task.key}: ${errorMessage(error)}`);
              }
            }
          },
        ),
      );
    } finally {
      useTasksUi.setState({ bulkStatusPending: false });
    }
  };
  const toggleSelection = useCallback((taskId: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const showProject = projectId === null;
  const filtered = hasActiveFilters(visibleFilters) || search.trim() !== "";

  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string; reveal: boolean } | null>(null);
  const pendingResume = useRef(resume);
  // Rows are still arriving while the primary query loads or the closed split trails it.
  const loading =
    tasksQuery.phase === "loading" || (tasksQuery.phase === "ready" && tasksQuery.closedPending);
  // The last scope whose rows finished loading, settled during render like `stored` above.
  const [settledScope, setSettledScope] = useState(scopeKey);
  if (!loading && settledScope !== scopeKey) setSettledScope(scopeKey);
  const scopeChanged = settledScope !== scopeKey;
  if (
    !loading &&
    !scopeChanged &&
    tasksQuery.phase === "ready" &&
    selectedTasks.length < selection.size
  ) {
    // A remotely deleted or moved task must not silently rejoin selection later.
    setSelection(new Set(selectedTasks.map(({ id }) => id)));
  }
  useListScrollRestoration(scrollRef, scopeKey, {
    contentReady: orderedTasks.length > 0,
    loading: loading || scopeChanged,
    revision: orderedTasks.length,
  });

  const viewport = useRowWindowViewport(scrollRef, groups);
  const anchorLayout = {
    groups: groups.map((group) => ({
      status: group.status,
      tasks: group.rows.map((row) => row.task),
    })),
    collapsed,
    rowHeight: viewport.rowHeight,
    headerHeight: viewport.headerHeight,
  };
  const visibleCounts = groups.map((group) => (collapsed[group.status] ? 0 : group.rows.length));
  const ranges = rowWindows({
    counts: visibleCounts,
    headerHeight: viewport.headerHeight,
    rowHeight: viewport.rowHeight,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
  });

  useLayoutEffect(() => {
    const container = scrollRef.current;
    openTaskRef.current = (taskKey) => {
      const task = orderedTasks.find(({ key }) => key === taskKey);
      if (!task || !container) return;
      onOpenTask(taskKey, {
        scopeKey,
        collapsed,
        selection,
        orderedRows: orderedTasks.map(({ id, key }) => ({ id, key })),
        openedId: task.id,
        anchor: captureListAnchor(anchorLayout, container.scrollTop),
      });
    };
    const saved = pendingResume.current;
    if (
      saved &&
      !loading &&
      container &&
      (viewport.rowHeight > 0 || orderedTasks.length === 0 || saved.anchor === null)
    ) {
      pendingResume.current = null;
      if (saved.scopeKey === scopeKey) {
        const target =
          saved.anchor &&
          resolveListAnchor(
            anchorLayout,
            saved.anchor,
            saved.orderedRows.map(({ id }) => id),
          );
        if (target !== null) container.scrollTop = target;
        const opened = orderedTasks.find(({ id }) => id === saved.openedId);
        if (opened) pendingFocus.current = { key: opened.key, reveal: false };
        container.focus({ preventScroll: true });
      }
    }
    const pending = pendingFocus.current;
    if (container === null || pending === null) return;
    // The anchor changes the mounted window on the next viewport update.
    const row = readRow(container, pending.key);
    if (!row) return;
    pendingFocus.current = null;
    if (!pending.reveal && document.activeElement !== container) return;
    row.focus({ preventScroll: true });
    if (pending.reveal) row.scrollIntoView?.({ block: "nearest" });
  });

  const moveFocus = (currentKey: string | undefined, direction: number) => {
    const current = orderedTasks.findIndex(({ key }) => key === currentKey);
    const index =
      current === -1
        ? direction < 0
          ? orderedTasks.length - 1
          : 0
        : Math.min(orderedTasks.length - 1, Math.max(0, current + direction));
    const next = orderedTasks[index];
    const container = scrollRef.current;
    if (!next || !container) return;
    const row = readRow(container, next.key);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
      row.scrollIntoView?.({ block: "nearest" });
      return;
    }
    const groupIndex = groups.findIndex((group) =>
      group.rows.some((entry) => entry.task.id === next.id),
    );
    pendingFocus.current = { key: next.key, reveal: true };
    container.scrollTop = Math.max(
      0,
      viewport.headerHeight * (groupIndex + 1) + viewport.rowHeight * index - viewport.height / 2,
    );
  };

  const listKeyDown = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    listKeyDown.current = (event) => {
      const container = scrollRef.current;
      const target = event.target;
      if (
        !container ||
        event.defaultPrevented ||
        isImeComposing(event) ||
        !isBareKey(event) ||
        !(target instanceof HTMLElement) ||
        target.isContentEditable ||
        target.closest('input, textarea, select, [role="textbox"]')
      )
        return;
      const checkboxRow = target.matches('[role="checkbox"]')
        ? target.closest<HTMLElement>("[data-task-key]")
        : null;
      const propertyRow = target.matches(
        '[aria-keyshortcuts="S"], [aria-keyshortcuts="P"], [aria-keyshortcuts="L"]',
      )
        ? target.closest<HTMLElement>("[data-task-key]")
        : null;
      const rowKey =
        target.dataset.openTask ?? checkboxRow?.dataset.taskKey ?? propertyRow?.dataset.taskKey;
      const page = listRef.current?.closest("[data-scott-tasks-page]");
      if (target !== document.body && !page?.contains(target)) return;
      if (hasOpenOverlay()) return;
      if (isNonImeKey(event, "Escape") && selectedTasks.length > 0) {
        event.preventDefault();
        setSelection(new Set());
        if (checkboxRow && rowKey) readRow(container, rowKey)?.focus({ preventScroll: true });
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k" || key === "arrowup" || key === "arrowdown") {
        event.preventDefault();
        const focusedKey = rowKey ?? (target === container ? pendingFocus.current?.key : undefined);
        moveFocus(focusedKey, key === "j" || key === "arrowdown" ? 1 : -1);
      }
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => listKeyDown.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  let body: ReactNode;
  if (tasksQuery.phase === "failed") {
    body = (
      <ViewEmptyState
        icon="AlertCircle"
        heading="Couldn't load tasks"
        description={tasksQuery.error}
      />
    );
  } else if (tasksQuery.phase === "loading") {
    body = <LoadingRows />;
  } else if (displayTasks.length === 0) {
    if (filtered) {
      body = (
        <ViewEmptyState
          icon="Search"
          heading="No tasks match these filters"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setSearch("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      );
    } else if (activeOnly) {
      body = (
        <ViewEmptyState
          icon="Zap"
          heading="No agents working right now"
          description="Dispatch a task to an agent preset and it will show up here while it runs."
        />
      );
    } else {
      body = (
        <ViewEmptyState
          icon="ListTodo"
          heading="No tasks yet"
          description="Create the first task to start tracking work."
          action={
            <Button
              size="sm"
              onClick={() =>
                openNewTask({ projectId, status: backlogOnly ? "backlog" : undefined })
              }
            >
              <Icon name="Plus" className="size-3.5" />
              New task
            </Button>
          }
        />
      );
    }
  } else {
    body = groups.map((group, groupIndex) => {
      const [start, end] = ranges[groupIndex] ?? [0, group.rows.length];
      const isCollapsed = collapsed[group.status] === true;
      const listId = `${groupId}-${group.status}`;
      const hiddenAbove = start * viewport.rowHeight;
      const hiddenBelow = (group.rows.length - end) * viewport.rowHeight;
      return (
        <section key={group.status}>
          <div
            data-status-group-header={group.status}
            className="group sticky top-0 z-20 isolate flex h-8 items-center justify-between bg-surface-recessed-solid px-3 text-xs @md:px-6 max-md:pointer-coarse:h-11"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              className="h-full gap-2 px-1 text-xs font-medium"
              onClick={() => setCollapsed((state) => ({ ...state, [group.status]: !isCollapsed }))}
            >
              <Icon
                name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                className="size-3 text-muted-foreground"
              />
              <StatusIcon status={group.status} />
              {STATUS_LABELS[group.status]}
              <Badge variant="count">{group.count}</Badge>
            </Button>
            <CompactButton
              type="button"
              variant="ghost"
              tone="muted"
              size="icon-sm"
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:pointer-coarse:size-11 max-md:pointer-coarse:opacity-100"
              aria-label={`New ${STATUS_LABELS[group.status]} task`}
              onClick={() => openNewTask({ projectId, status: group.status })}
            >
              <Icon name="Plus" className="size-3.5" />
            </CompactButton>
          </div>
          <div id={listId} hidden={isCollapsed}>
            {!isCollapsed ? (
              <>
                {hiddenAbove > 0 ? <div aria-hidden style={{ height: hiddenAbove }} /> : null}
                {group.rows.slice(start, end).map(({ task, child, open }) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    child={child}
                    muted={!taskMatches(task, matchCriteria)}
                    subTasks={child ? undefined : childTotals.get(task.id)}
                    subTasksOpen={open}
                    subTasksLocked={open && !expanded.includes(task.id)}
                    onToggleSubTasks={child ? undefined : toggleSubTasks}
                    activeThreads={activeThreads.get(task.id)}
                    project={projectsById.get(task.projectId)}
                    showProject={showProject}
                    labelsById={labelsById}
                    projectLabels={labelsByProject.get(task.projectId) ?? NO_LABELS}
                    projects={projectList}
                    onMoveToProject={moveToProject}
                    onEdit={onEdit}
                    onOpen={openTask}
                    selected={selection.has(task.id)}
                    selectionActive={selectedTasks.length > 0}
                    onToggleSelection={toggleSelection}
                    pending={hasPendingWrites(task)}
                  />
                ))}
                {hiddenBelow > 0 ? <div aria-hidden style={{ height: hiddenBelow }} /> : null}
              </>
            ) : null}
          </div>
        </section>
      );
    });
  }

  return (
    <div ref={listRef} className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        filters={visibleFilters}
        onChange={setFilters}
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
        labelOptions={labelOptions}
        taskCount={taskCount}
        fixedStatus={backlogOnly}
      />
      {selectedTasks.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-border-hairline px-4 text-xs">
          <span role="status" className="mr-auto tabular-nums">
            {selectedTasks.length} selected
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="max-md:pointer-coarse:h-11"
                disabled={bulkStatusPending}
              >
                Set status
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" mobileTitle="Set status">
              {TASK_STATUSES.map((status) => (
                <DropdownMenuItem key={status} onSelect={() => void setBulkStatus(status)}>
                  <StatusIcon status={status} />
                  {STATUS_LABELS[status]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="max-md:pointer-coarse:h-11"
            onClick={() => setSelection(new Set())}
          >
            Clear selection
          </Button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Task list"
        tabIndex={-1}
        aria-keyshortcuts="J K ArrowUp ArrowDown"
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none"
      >
        <KeyColumnScope
          keys={widestKeys}
          className="@container flex min-h-full flex-col max-md:pointer-coarse:pb-22"
        >
          {body}
        </KeyColumnScope>
      </div>
    </div>
  );
}
