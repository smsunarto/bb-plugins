import { useMemo } from "react";
import { eq, isNull } from "@tanstack/react-db";
import type { Project, Task } from "../shared/contract.js";
import { sortTasks } from "../shared/sort.js";
import { groupTasksByStatus } from "../views/list/lib.js";
import { tasksCollection } from "./collections.js";
import { useTasksLiveQuery } from "./data.js";
import { refreshTasks } from "./sync.js";
import { useTasksUi } from "./ui-store.js";
import type { ResolvedTasksRoute, TaskViewMode, TasksRoute } from "./routes.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Hint } from "../components/hint.js";

const REFRESH_TASKS_LABEL = "Refresh tasks";

interface PagerPosition {
  index: number;
  total: number;
  prevKey: string | null;
  nextKey: string | null;
}

export function pagerPosition(tasks: readonly Task[], taskKey: string): PagerPosition | null {
  const ordered = groupTasksByStatus(sortTasks(tasks, "manual")).flatMap((group) =>
    group.tasks.map(({ key }) => key),
  );
  return orderedPagerPosition(ordered, taskKey);
}

function orderedPagerPosition(ordered: readonly string[], taskKey: string): PagerPosition | null {
  const wanted = taskKey.toUpperCase();
  const index = ordered.findIndex((key) => key.toUpperCase() === wanted);
  if (index === -1) return null;
  return {
    index: index + 1,
    total: ordered.length,
    prevKey: ordered[index - 1] ?? null,
    nextKey: ordered[index + 1] ?? null,
  };
}

function TaskDetailPager({
  taskKey,
  rows,
  projectId,
  onNavigate,
}: {
  taskKey: string;
  rows: readonly Pick<Task, "id" | "key">[] | null;
  projectId: string | null | undefined;
  onNavigate: (route: TasksRoute) => void;
}) {
  const siblings = useTasksLiveQuery(["task-pager", rows === null ? projectId : undefined], (q) => {
    if (rows !== null || projectId === undefined) return undefined;
    const topLevel = q
      .from({ task: tasksCollection })
      .where(({ task }) => isNull(task.parentTaskId));
    return projectId === null
      ? topLevel
      : topLevel.where(({ task }) => eq(task.projectId, projectId));
  });
  const position = useMemo(() => {
    if (rows !== null)
      return orderedPagerPosition(
        rows.map(({ key }) => key),
        taskKey,
      );
    return siblings.isReady && siblings.data ? pagerPosition(siblings.data, taskKey) : null;
  }, [siblings.isReady, siblings.data, taskKey, rows]);
  return <TaskPager position={position} onNavigate={onNavigate} />;
}

function TaskPager({
  position,
  onNavigate,
}: {
  position: PagerPosition | null;
  onNavigate: (route: TasksRoute) => void;
}) {
  if (!position) return null;
  const step = (key: string | null) => {
    if (key !== null) onNavigate({ kind: "task", taskKey: key });
  };
  return (
    <div className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground @sm:flex">
      <span className="hidden px-1 @md:inline">
        {position.index} / {position.total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 max-md:pointer-coarse:size-11"
        aria-label="Previous task"
        disabled={position.prevKey === null}
        onClick={() => step(position.prevKey)}
      >
        <Icon name="ChevronUp" className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 max-md:pointer-coarse:size-11"
        aria-label="Next task"
        disabled={position.nextKey === null}
        onClick={() => step(position.nextKey)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: TaskViewMode;
  onChange: (view: TaskViewMode) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      aria-label="View"
      value={view}
      onValueChange={(next) => {
        // Pressing the current view emits "", which still pins that view as before.
        onChange(next === "list" || next === "board" ? next : view);
      }}
      className="gap-0.5"
    >
      <ToggleGroupItem
        value="list"
        aria-label="List"
        title="List view"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground max-md:pointer-coarse:size-11"
      >
        <Icon name="ListView" className="size-4 shrink-0" />
        <span className="hidden @md:inline max-md:pointer-coarse:hidden">List</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="board"
        aria-label="Board"
        title="Board view"
        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground max-md:pointer-coarse:size-11"
      >
        <Icon name="Columns2" className="size-4 shrink-0" />
        <span className="hidden @md:inline max-md:pointer-coarse:hidden">Board</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function RefreshTasksButton() {
  const isRefreshing = useTasksUi((state) => state.refreshing);

  return (
    <Hint label={REFRESH_TASKS_LABEL} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground active:bg-state-active active:text-foreground max-md:pointer-coarse:size-11"
        aria-label={REFRESH_TASKS_LABEL}
        aria-busy={isRefreshing}
        disabled={isRefreshing}
        onClick={refreshTasks}
      >
        <Icon name="RotateCcw" className={cn("size-3.5", isRefreshing && "animate-spin")} />
      </Button>
    </Hint>
  );
}

const BROWSE_TABS = [
  { id: "all", label: "All", icon: "ListView" },
  { id: "active", label: "Active", icon: "Zap" },
  { id: "backlog", label: "Backlog", icon: "Circle" },
] as const;

function TaskViewTabs({
  route,
  onNavigate,
}: {
  route: Extract<ResolvedTasksRoute, { kind: "all" | "active" | "backlog" | "project" }>;
  onNavigate: (route: TasksRoute) => void;
}) {
  const current = route.kind === "project" ? (route.scope ?? "all") : route.kind;
  return (
    <nav aria-label="Task views" className="flex min-w-0 items-center gap-1">
      {BROWSE_TABS.map(({ id, label, icon }) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          aria-current={id === current ? "page" : undefined}
          className={cn(
            "h-7 gap-1.5 px-2 text-xs max-md:pointer-coarse:h-11",
            id === current
              ? "bg-state-active font-semibold text-foreground"
              : "text-muted-foreground",
          )}
          onClick={() => {
            if (route.kind !== "project") {
              onNavigate({ kind: id });
              return;
            }
            onNavigate({
              kind: "project",
              projectId: route.projectId,
              view: id === "all" ? null : "list",
              ...(id === "all" ? {} : { scope: id }),
            });
          }}
        >
          <Icon name={icon} className="size-3.5" />
          {label}
        </Button>
      ))}
    </nav>
  );
}

interface TasksTopbarProps {
  route: ResolvedTasksRoute;
  projects: Project[] | undefined;
  pagerScope: { projectId: string | null } | null;
  pagerRows: readonly Pick<Task, "id" | "key">[] | null;
  onNavigate: (route: TasksRoute) => void;
  onNewTask: () => void;
  onBack: () => void;
}

export function TasksTopbar({
  route,
  projects,
  pagerScope,
  pagerRows,
  onNavigate,
  onNewTask,
  onBack,
}: TasksTopbarProps) {
  const project = useMemo(() => {
    if (route.kind === "project") {
      return (projects ?? []).find((p) => p.id === route.projectId) ?? null;
    }
    if (route.kind === "task") {
      const prefix = route.taskKey.split("-", 1)[0] ?? "";
      return (projects ?? []).find((p) => p.prefix === prefix) ?? null;
    }
    return null;
  }, [route, projects]);

  const browsing =
    route.kind === "all" ||
    route.kind === "active" ||
    route.kind === "backlog" ||
    route.kind === "project";
  const breadcrumb = (() => {
    switch (route.kind) {
      case "all":
        return <span className="whitespace-nowrap font-semibold">All tasks</span>;
      case "active":
        return <span className="font-semibold">Active tasks</span>;
      case "backlog":
        return <span className="font-semibold">Backlog</span>;
      case "manage":
        return (
          <span className="flex items-center gap-2">
            <span className="whitespace-nowrap font-semibold">Manage</span>
            <span className="hidden text-xs font-normal text-muted-foreground @md:inline">
              labels, presets, folders
            </span>
          </span>
        );
      case "project":
        return (
          <span className="flex min-w-0 items-center gap-2">
            {project ? (
              <span
                aria-hidden
                className="size-3 shrink-0 rounded-sm"
                style={{ backgroundColor: project.color }}
              />
            ) : null}
            <span className="truncate font-semibold">{project?.name ?? "Project"}</span>
            <Icon
              name="ChevronRight"
              className="size-3 shrink-0 text-muted-foreground max-md:pointer-coarse:hidden"
            />
            <span className="text-xs font-normal text-muted-foreground max-md:pointer-coarse:hidden">
              {route.scope === "active"
                ? "Active"
                : route.scope === "backlog"
                  ? "Backlog"
                  : "Tasks"}
            </span>
          </span>
        );
      case "task":
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 max-md:pointer-coarse:size-11"
              aria-label="Back (Esc)"
              onClick={onBack}
            >
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="flex-nowrap gap-2 sm:gap-2">
                {project ? (
                  <>
                    <BreadcrumbItem className="hidden min-w-0 @md:inline-flex">
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2"
                          onClick={() =>
                            onNavigate({
                              kind: "project",
                              projectId: project.id,
                              view: null,
                            })
                          }
                        >
                          <span
                            aria-hidden
                            className="size-3 shrink-0 rounded-sm"
                            style={{ backgroundColor: project.color }}
                          />
                          <span className="truncate font-medium">{project.name}</span>
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden @md:block" />
                  </>
                ) : null}
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate font-medium text-muted-foreground">
                    {route.taskKey}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </span>
        );
    }
  })();

  return (
    <header
      className={cn(
        "shrink-0 bg-background px-3 @md:px-6",
        browsing &&
          "@3xl:grid @3xl:min-h-12 @3xl:grid-cols-[auto_minmax(0,1fr)_auto] @3xl:items-center @3xl:gap-4",
      )}
    >
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 text-sm",
          browsing
            ? "max-md:pointer-coarse:min-h-15 @3xl:contents"
            : "max-md:pointer-coarse:min-h-12",
        )}
      >
        <div
          className={cn(
            "min-w-0 flex-1 overflow-hidden",
            browsing &&
              "max-md:pointer-coarse:text-2xl max-md:pointer-coarse:tracking-tight @3xl:col-start-1 @3xl:row-start-1 @3xl:max-w-64",
          )}
        >
          {breadcrumb}
        </div>
        <div className="flex shrink-0 items-center gap-2 @3xl:col-start-3 @3xl:row-start-1">
          {route.kind === "task" && (
            <TaskDetailPager
              taskKey={route.taskKey}
              rows={pagerRows}
              projectId={
                pagerScope === null ? projects && (project?.id ?? null) : pagerScope.projectId
              }
              onNavigate={onNavigate}
            />
          )}
          <RefreshTasksButton />
          {browsing ? (
            <Hint label="New task (C)" side="bottom">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs max-md:pointer-coarse:absolute max-md:pointer-coarse:bottom-[max(1rem,env(safe-area-inset-bottom))] max-md:pointer-coarse:right-4 max-md:pointer-coarse:z-30 max-md:pointer-coarse:h-12 max-md:pointer-coarse:rounded-full max-md:pointer-coarse:bg-primary max-md:pointer-coarse:px-4 max-md:pointer-coarse:text-sm max-md:pointer-coarse:text-primary-foreground max-md:pointer-coarse:shadow-md"
                aria-label="New task"
                aria-keyshortcuts="C"
                onClick={onNewTask}
              >
                <Icon name="Plus" className="size-3.5" />
                New task
              </Button>
            </Hint>
          ) : null}
        </div>
      </div>
      {browsing ? (
        <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border-hairline @3xl:col-start-2 @3xl:row-start-1 @3xl:border-b-0">
          <TaskViewTabs route={route} onNavigate={onNavigate} />
          {route.kind === "project" ? (
            <ViewToggle
              view={route.view}
              onChange={(view) =>
                onNavigate({
                  kind: "project",
                  projectId: route.projectId,
                  view,
                  ...(view === "list" && route.scope !== undefined ? { scope: route.scope } : {}),
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
