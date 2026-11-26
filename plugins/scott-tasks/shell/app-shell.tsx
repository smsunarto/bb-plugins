import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useProjects } from "./data.js";
import { subscribeToTaskRecords } from "./collections.js";
import {
  parseTasksRoute,
  tasksRouteToSubPath,
  useTasksNavigation,
  type ResolvedTasksRoute,
  type TasksNavigation,
  type TasksRoute,
} from "./routes.js";
import { loadViewMode, storeViewMode } from "./view-preference.js";
import { TasksTopbar } from "./topbar.js";
import { ListView, type ListResume } from "../views/list/index.js";
import { DetailToasts, useDetailToasts } from "../views/detail/toast.js";
import { BoardView } from "../views/board/index.js";
import { DetailView } from "../views/detail/index.js";
import { NewTaskDialog } from "../views/manage/new-task-dialog.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { ManagePanel } from "../views/manage/manage-panel.js";
import { ViewEmptyState } from "../components/empty-state.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TasksDataRoot } from "./data-root.js";
import { useTasksUi } from "./ui-store.js";
import { hasOpenOverlay } from "./keyboard.js";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function RouteOutlet({
  route,
  onOpenTask,
  resume,
  onError,
}: {
  route: ResolvedTasksRoute;
  onOpenTask: (taskKey: string, resume: ListResume) => void;
  resume: ListResume | null;
  onError: (message: string) => void;
}) {
  const listProps = { onOpenTask, resume, onError };
  switch (route.kind) {
    case "all":
      return <ListView projectId={null} {...listProps} />;
    case "active":
    case "backlog":
      return <ListView projectId={null} scope={route.kind} {...listProps} />;
    case "manage":
      return <ManagePanel />;
    case "task":
      return <DetailView taskKey={route.taskKey} />;
    case "project":
      return route.view === "board" ? (
        <BoardView projectId={route.projectId} onError={onError} />
      ) : (
        <ListView projectId={route.projectId} scope={route.scope} {...listProps} />
      );
  }
}

function resolveRoute(route: TasksRoute): ResolvedTasksRoute {
  if (route.kind !== "project") return route;
  return { ...route, view: route.scope ? "list" : (route.view ?? loadViewMode(route.projectId)) };
}

function TasksAppShellContent({ subPath }: PluginNavPanelProps) {
  const route = resolveRoute(parseTasksRoute(subPath));
  const tasksNavigation = useTasksNavigation();
  const navigation = useMemo<TasksNavigation>(
    () => ({
      go: (target, options) => {
        if (target.kind === "project" && target.view !== null && target.scope === undefined) {
          storeViewMode(target.projectId, target.view);
        }
        tasksNavigation.go(target, options);
      },
    }),
    [tasksNavigation],
  );
  const newTask = useTasksUi((state) => state.newTask);
  const openNewTask = useTasksUi((state) => state.openNewTask);
  const closeNewTask = useTasksUi((state) => state.closeNewTask);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const projects = useProjects();

  const lastBrowseRouteRef = useRef<TasksRoute | null>(null);
  const listResume = useRef<ListResume | null>(null);
  const [pagerRows, setPagerRows] = useState<ListResume["orderedRows"] | null>(null);
  const { toasts, push, dismiss } = useDetailToasts();
  const openListTask = useCallback(
    (taskKey: string, resume: ListResume) => {
      // Retain what the user was browsing across detail-to-detail navigation.
      listResume.current = resume;
      setPagerRows(resume.orderedRows);
      navigation.go({ kind: "task", taskKey });
    },
    [navigation],
  );
  useEffect(
    () =>
      subscribeToTaskRecords((id, key) => {
        if (!listResume.current) return;
        setPagerRows((rows) => {
          const row = rows?.find((row) => row.id === id);
          if (!rows || !row || row.key === key) return rows;
          if (key === null) return rows.filter((row) => row.id !== id);
          return rows.map((row) => (row.id === id ? { id, key } : row));
        });
      }),
    [],
  );
  useEffect(() => {
    if (route.kind !== "task") {
      lastBrowseRouteRef.current = route;
      listResume.current = null;
    }
    // oxlint-disable-next-line react/exhaustive-deps
  }, [subPath]);
  const backFromTask = () => navigation.go(lastBrowseRouteRef.current ?? { kind: "all" });
  const onTaskRoute = route.kind === "task";
  const backRef = useRef(backFromTask);
  backRef.current = backFromTask;
  useEffect(() => {
    if (!onTaskRoute) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      backRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTaskRoute]);

  const noProjects = projects.data !== undefined && projects.data.length === 0;
  const newTaskProjectId = route.kind === "project" ? route.projectId : null;
  const newTaskStatus =
    route.kind === "backlog" || (route.kind === "project" && route.scope === "backlog")
      ? "backlog"
      : undefined;
  const lastBrowseRoute = lastBrowseRouteRef.current;
  const resume =
    lastBrowseRoute && tasksRouteToSubPath(lastBrowseRoute) === tasksRouteToSubPath(route)
      ? listResume.current
      : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      event.preventDefault();
      openNewTask({ projectId: newTaskProjectId, status: newTaskStatus });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewTask, newTaskProjectId, newTaskStatus]);

  return (
    <div
      data-bb-plugin="scott-tasks"
      data-scott-tasks-page=""
      className="relative flex h-full min-h-0 bg-background text-foreground"
    >
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TasksTopbar
          route={route}
          projects={projects.data}
          pagerRows={listResume.current === null ? null : pagerRows}
          pagerScope={
            lastBrowseRouteRef.current === null
              ? null
              : {
                  projectId:
                    lastBrowseRouteRef.current.kind === "project"
                      ? lastBrowseRouteRef.current.projectId
                      : null,
                }
          }
          onNavigate={navigation.go}
          onNewTask={() => openNewTask({ projectId: newTaskProjectId, status: newTaskStatus })}
          onBack={backFromTask}
        />
        <div
          className={
            route.kind === "project" && route.view === "board"
              ? "min-h-0 flex-1 overflow-hidden"
              : "min-h-0 flex-1 overflow-auto"
          }
        >
          {noProjects && route.kind !== "task" && route.kind !== "manage" ? (
            <ViewEmptyState
              icon="ListTodo"
              heading="No projects yet"
              description="Create a project to start tracking tasks and dispatching work to agents."
              action={
                <Button size="sm" onClick={() => setNewProjectOpen(true)}>
                  <Icon name="Plus" className="size-3.5" />
                  New project
                </Button>
              }
            />
          ) : (
            <RouteOutlet route={route} onOpenTask={openListTask} resume={resume} onError={push} />
          )}
        </div>
      </main>
      <NewTaskDialog
        open={newTask !== null}
        onOpenChange={(open) => {
          if (!open) closeNewTask();
        }}
        projectId={newTask?.projectId ?? null}
        defaultStatus={newTask?.status}
      />
      <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export function TasksAppShell(props: PluginNavPanelProps) {
  return (
    <TasksDataRoot>
      <TasksAppShellContent {...props} />
    </TasksDataRoot>
  );
}
