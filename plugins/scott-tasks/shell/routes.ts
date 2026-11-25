import { useMemo } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

export const PANEL_PATH = "tasks";

export type TaskViewMode = "list" | "board";
export type TaskScope = "active" | "backlog";

export type TasksRoute =
  | { kind: "all" }
  | { kind: "active" }
  | { kind: "backlog" }
  | { kind: "manage" }
  | { kind: "project"; projectId: string; view: TaskViewMode | null; scope?: TaskScope }
  | { kind: "task"; taskKey: string };

export type ResolvedTasksRoute =
  | Exclude<TasksRoute, { kind: "project" }>
  | { kind: "project"; projectId: string; view: TaskViewMode; scope?: TaskScope };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseTasksRoute(rawSubPath: string): TasksRoute {
  const subPath = rawSubPath.split("/").map(decodeSegment).join("/");
  const queryIndex = subPath.indexOf("?");
  const path = queryIndex === -1 ? subPath : subPath.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : subPath.slice(queryIndex + 1);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === undefined || head === "all") return { kind: "all" };
  if (head === "active") return { kind: "active" };
  if (head === "backlog") return { kind: "backlog" };
  if (head === "manage") return { kind: "manage" };
  if (head === "task") {
    const taskKey = segments[1];
    if (taskKey !== undefined) return { kind: "task", taskKey };
    return { kind: "all" };
  }
  const params = new URLSearchParams(query);
  const view = params.get("view");
  const scope = params.get("scope");
  return {
    kind: "project",
    projectId: head,
    view: view === "board" || view === "list" ? view : null,
    ...(scope === "active" || scope === "backlog" ? { scope } : {}),
  };
}

export function tasksRouteToSubPath(route: TasksRoute): string {
  switch (route.kind) {
    case "all":
      return "all";
    case "active":
      return "active";
    case "backlog":
      return "backlog";
    case "manage":
      return "manage";
    case "task":
      return `task/${route.taskKey}`;
    case "project": {
      const params = new URLSearchParams();
      if (route.view !== null) params.set("view", route.view);
      if (route.scope !== undefined) params.set("scope", route.scope);
      return params.size ? `${route.projectId}?${params}` : route.projectId;
    }
  }
}

export interface TasksNavigation {
  go: (route: TasksRoute, options?: { replace?: boolean }) => void;
}

export function useTasksNavigation(): TasksNavigation {
  const navigate = useBbNavigate();
  return useMemo(
    () => ({
      go: (route, options) => {
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: tasksRouteToSubPath(route),
          ...(options?.replace ? { replace: true } : {}),
        });
      },
    }),
    [navigate],
  );
}
