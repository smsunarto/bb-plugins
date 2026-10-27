import { focusManager, QueryClient, queryOptions, type QueryKey } from "@tanstack/react-query";
import type { PluginRpcClient } from "@get-bb/plugin-sdk";
import { tasksRpcContract, type TasksRpcContract } from "../shared/contract.js";
import { readQuerySnapshot, writeQuerySnapshot } from "./query-snapshot.js";

export type TasksRpc = PluginRpcClient<TasksRpcContract>;

/**
 * The plugin's one cache. It lives as long as the app bundle, so remounted
 * panels paint what an earlier mount read. Realtime signals, reconnects, and
 * the refresh control keep it fresh; failures surface at once instead of
 * retrying behind a spinner.
 */
export const tasksQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Persist the accepted result of snapshot reads, so the next mount paints it first.
tasksQueryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.action.type !== "success") return;
  const snapshot = event.query.meta?.snapshot;
  if (typeof snapshot === "string") writeQuerySnapshot(snapshot, event.query.state.data);
});

// Query listens for tab visibility only; returning to the bb window from another app counts too.
focusManager.setEventListener((onFocus) => {
  if (typeof window === "undefined") return undefined;
  const listener = () => onFocus();
  window.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  return () => {
    window.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
  };
});

let currentRpc: TasksRpc | null = null;

/**
 * Every bb RPC client calls the same plugin endpoint, so module-level reads
 * (collections, sync) use whichever one the latest Tasks surface supplied.
 */
export function setTasksRpc(rpc: TasksRpc | null): void {
  currentRpc = rpc;
}

export function tasksRpc(): TasksRpc {
  if (currentRpc === null)
    throw new Error("Tasks data is unavailable until a Tasks surface mounts");
  return currentRpc;
}

export const tasksKeys = {
  folders: ["folders"],
  projects: ["projects"],
  presets: ["presets"],
  labels: ["labels"],
  sidebarSummary: ["sidebarSummary"],
  openTaskCount: ["openTaskCount"],
  machines: ["machines"],
  bbProjects: ["bbProjects"],
  attachments: (taskId: string) => ["attachments", taskId],
  comments: (taskId: string) => ["comments", taskId],
  pullRequests: (taskId: string) => ["pullRequests", taskId],
} as const satisfies Record<string, QueryKey | ((taskId: string) => QueryKey)>;

function snapshot<T>(name: string, read: () => T | undefined) {
  return {
    meta: { snapshot: name },
    initialData: read,
    // The snapshot is a last-known value: paint it, then read the server.
    initialDataUpdatedAt: 0,
  };
}

export const foldersQuery = queryOptions({
  queryKey: tasksKeys.folders,
  queryFn: async () => (await tasksRpc().call("listFolders")).folders,
  ...snapshot("folders", () =>
    readQuerySnapshot("folders", tasksRpcContract.listFolders.output.shape.folders),
  ),
});

export const projectsQuery = queryOptions({
  queryKey: tasksKeys.projects,
  queryFn: async () => (await tasksRpc().call("listProjects", {})).projects,
  ...snapshot("projects", () =>
    readQuerySnapshot("projects", tasksRpcContract.listProjects.output.shape.projects),
  ),
});

export const sidebarSummaryQuery = queryOptions({
  queryKey: tasksKeys.sidebarSummary,
  queryFn: async () => (await tasksRpc().call("sidebarSummary")).projects,
  ...snapshot("sidebar-summary", () =>
    readQuerySnapshot("sidebar-summary", tasksRpcContract.sidebarSummary.output.shape.projects),
  ),
});

export const presetsQuery = queryOptions({
  queryKey: tasksKeys.presets,
  queryFn: async () => (await tasksRpc().call("listPresets")).presets,
});

/** Every project's labels: one read serves the list, board, detail, and dialogs. */
export const labelsQuery = queryOptions({
  queryKey: tasksKeys.labels,
  queryFn: async () => (await tasksRpc().call("listLabels", {})).labels,
});

export const openTaskCountQuery = queryOptions({
  queryKey: tasksKeys.openTaskCount,
  queryFn: async () => (await tasksRpc().call("sidebarOpenTaskCount")).openTaskCount,
});

export const machinesQuery = queryOptions({
  queryKey: tasksKeys.machines,
  queryFn: async () => (await tasksRpc().call("listMachines", {})).machines,
});

export const bbProjectsQuery = queryOptions({
  queryKey: tasksKeys.bbProjects,
  queryFn: async () => (await tasksRpc().call("listBbProjects")).bbProjects,
});

export function attachmentsQuery(taskId: string) {
  return queryOptions({
    queryKey: tasksKeys.attachments(taskId),
    queryFn: async () => (await tasksRpc().call("listAttachments", { taskId })).attachments,
  });
}

export function commentsQuery(taskId: string) {
  return queryOptions({
    queryKey: tasksKeys.comments(taskId),
    queryFn: async () => (await tasksRpc().call("listComments", { taskId })).comments,
  });
}

export function pullRequestsQuery(taskId: string) {
  return queryOptions({
    queryKey: tasksKeys.pullRequests(taskId),
    queryFn: () => tasksRpc().call("listTaskPullRequests", { taskId }),
  });
}
