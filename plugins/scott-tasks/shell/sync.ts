import { useEffect } from "react";
import { hashKey, type QueryKey } from "@tanstack/react-query";
import {
  useRealtime,
  useRealtimeConnectionState,
  type PluginRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import {
  attachmentCountsCollection,
  countAttachments,
  deleteServerTask,
  showsAttachmentCount,
  writeServerTask,
} from "./collections.js";
import { tasksKeys, tasksQueryClient, tasksRpc } from "./query.js";
import { useTasksUi } from "./ui-store.js";

/**
 * Realtime signals → cache. Every mounted Tasks surface hears the same
 * signal, so a short window collapses duplicates and bursts into one batch.
 */

const CHANNELS = [
  "tasks:changed",
  "projects:changed",
  "comments:changed",
  "threads:changed",
] as const;

type Channel = (typeof CHANNELS)[number];

const SIGNAL_BATCH_MS = 50;

/** `channel:subject` per signal; a null subject means "anything on this channel changed". */
interface Signal {
  channel: Channel;
  subject: string | null;
}

let pendingSignals = new Map<string, Signal>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** The task, or for `projects:changed` the project, a signal names. */
function subjectOf(channel: Channel, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const subject: unknown = Reflect.get(
    payload,
    channel === "projects:changed" ? "projectId" : "taskId",
  );
  return typeof subject === "string" ? subject : null;
}

function enqueue(channel: Channel, payload: unknown): void {
  const subject = subjectOf(channel, payload);
  pendingSignals.set(`${channel}:${subject ?? "*"}`, { channel, subject });
  batchTimer ??= setTimeout(() => {
    batchTimer = null;
    const batch = [...pendingSignals.values()];
    pendingSignals = new Map();
    void applySignals(batch).finally(advanceSync);
  }, SIGNAL_BATCH_MS);
}

/**
 * A collection hands a new live query the cached error of a failed subset,
 * so failed reads restart before live queries retry under new identities.
 */
export function refetchFailedReads(): void {
  void tasksQueryClient.refetchQueries(
    { type: "active", predicate: (query) => query.state.status === "error" },
    { cancelRefetch: false },
  );
}

/** Tell failed live queries to retry once sync has settled. */
function advanceSync(): void {
  refetchFailedReads();
  useTasksUi.getState().advanceSync();
}

const trailingRefreshes = new Set<string>();

/**
 * Refetch the matching queries. A read already in flight may predate the
 * change, so it finishes and one more read follows it.
 */
async function refresh(queryKey: QueryKey): Promise<void> {
  if (tasksQueryClient.isFetching({ queryKey }) === 0) {
    await tasksQueryClient.invalidateQueries({ queryKey });
    return;
  }
  const hash = hashKey(queryKey);
  if (trailingRefreshes.has(hash)) return;
  trailingRefreshes.add(hash);
  try {
    await tasksQueryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  } finally {
    trailingRefreshes.delete(hash);
  }
  await tasksQueryClient.invalidateQueries({ queryKey });
}

const patching = new Map<string, Promise<void>>();
const repatch = new Set<string>();

/** Re-read one task into the collection; a signal during the read queues one more. */
function patchTask(taskId: string): Promise<void> {
  const running = patching.get(taskId);
  if (running) {
    repatch.add(taskId);
    return running;
  }
  const run = (async () => {
    const { task } = await tasksRpc().call("getTask", { taskId });
    if (task === null) {
      await deleteServerTask(taskId);
    } else {
      // A write or refresh that landed during the read already carries a newer version.
      await writeServerTask(task);
    }
  })().finally(() => {
    patching.delete(taskId);
    if (repatch.delete(taskId)) void patchTask(taskId);
  });
  patching.set(taskId, run);
  return run;
}

/**
 * Task reads a project change may have made stale: those holding one of its
 * rows, and those still in flight, whose answer may predate the change.
 */
function projectTaskReads(projectIds: readonly string[]): QueryKey[] {
  return tasksQueryClient
    .getQueryCache()
    .findAll({ queryKey: ["tasks"] })
    .filter((query) => {
      const rows: unknown = query.state.data;
      return (
        query.state.fetchStatus === "fetching" ||
        !Array.isArray(rows) ||
        rows.some((row: { projectId?: unknown }) => projectIds.includes(String(row.projectId)))
      );
    })
    .map((query) => query.queryKey);
}

async function patchAttachmentCounts(taskIds: readonly string[]): Promise<void> {
  const loaded = taskIds.filter(showsAttachmentCount);
  if (loaded.length === 0) return;
  const counts = await countAttachments(loaded);
  await attachmentCountsCollection.utils.writeUpsert(counts);
}

async function applySignals(signals: readonly Signal[]): Promise<void> {
  const ids = (channel: Channel) =>
    signals.flatMap((signal) =>
      signal.channel === channel && signal.subject !== null ? [signal.subject] : [],
    );
  const any = (channel: Channel) => signals.some((signal) => signal.channel === channel);
  const everything = (channel: Channel) =>
    signals.some((signal) => signal.channel === channel && signal.subject === null);
  // Several signals name the same read; each runs once per batch.
  const stale = new Map<string, QueryKey>();
  const invalidate = (queryKey: QueryKey) => stale.set(hashKey(queryKey), queryKey);
  const patches: Promise<unknown>[] = [];

  if (any("tasks:changed")) {
    invalidate(tasksKeys.sidebarSummary);
    invalidate(tasksKeys.openTaskCount);
    if (everything("tasks:changed")) {
      for (const queryKey of [["tasks"], ["attachmentCounts"], ["attachments"], ["comments"]]) {
        invalidate(queryKey);
      }
    } else {
      // Patch only the rows that changed; a failed patch falls back to a full re-read.
      const taskIds = ids("tasks:changed");
      patches.push(
        Promise.all(taskIds.map(patchTask)).catch(() => refresh(["tasks"])),
        patchAttachmentCounts(taskIds).catch(() => refresh(["attachmentCounts"])),
      );
      for (const taskId of taskIds) {
        invalidate(tasksKeys.attachments(taskId));
        invalidate(tasksKeys.comments(taskId));
      }
    }
  }
  if (any("projects:changed")) {
    for (const queryKey of [
      tasksKeys.folders,
      tasksKeys.projects,
      tasksKeys.presets,
      tasksKeys.labels,
      tasksKeys.sidebarSummary,
      tasksKeys.openTaskCount,
      tasksKeys.bbProjects,
    ]) {
      invalidate(queryKey);
    }
    // Deleting a project or label rewrites tasks the signal does not name.
    if (everything("projects:changed")) invalidate(["tasks"]);
    else for (const queryKey of projectTaskReads(ids("projects:changed"))) invalidate(queryKey);
  }
  if (any("comments:changed")) {
    if (everything("comments:changed")) invalidate(["comments"]);
    for (const taskId of ids("comments:changed")) invalidate(tasksKeys.comments(taskId));
  }
  if (any("threads:changed")) {
    invalidate(["taskThreads"]);
    invalidate(tasksKeys.sidebarSummary);
    if (everything("threads:changed")) invalidate(["pullRequests"]);
    for (const taskId of ids("threads:changed")) invalidate(tasksKeys.pullRequests(taskId));
  }
  await Promise.allSettled([...patches, ...[...stale.values()].map(refresh)]);
}

/**
 * Re-read everything the cache holds: active reads now, the rest on next use.
 * A read already in flight is superseded, so its late result cannot land.
 */
export async function refetchAll(): Promise<void> {
  try {
    // Query cancels in-flight reads that have data; a first read would be joined instead.
    await tasksQueryClient.cancelQueries({
      fetchStatus: "fetching",
      predicate: (query) => query.state.data === undefined,
    });
    await tasksQueryClient.invalidateQueries();
  } finally {
    // The sweep already re-read failed subsets.
    useTasksUi.getState().advanceSync();
  }
}

/** The refresh control: one sweep at a time across every surface. */
export function refreshTasks(): void {
  const ui = useTasksUi.getState();
  if (ui.refreshing) return;
  ui.setRefreshing(true);
  void refetchAll().finally(() => useTasksUi.getState().setRefreshing(false));
}

/**
 * Whether the realtime connection has ever been up. A drop and recovery may
 * have missed signals, so it re-reads; the first connection does not.
 */
let connection: { state: PluginRealtimeConnectionState; established: boolean } | null = null;

function observeConnection(state: PluginRealtimeConnectionState): void {
  const previous = connection;
  if (previous === null) {
    connection = { state, established: state !== "connecting" };
    return;
  }
  if (previous.state === state) return;
  const recovered = state === "connected" && previous.established;
  connection = {
    state,
    established: previous.established || state === "connected" || state === "reconnecting",
  };
  if (recovered) void refetchAll();
}

/** Mount in every Tasks surface: it feeds realtime signals and reconnects into the shared cache. */
export function useTasksSync(): void {
  useRealtime("tasks:changed", (payload) => enqueue("tasks:changed", payload));
  useRealtime("projects:changed", (payload) => enqueue("projects:changed", payload));
  useRealtime("comments:changed", (payload) => enqueue("comments:changed", payload));
  useRealtime("threads:changed", (payload) => enqueue("threads:changed", payload));
  const connectionState = useRealtimeConnectionState();
  useEffect(() => observeConnection(connectionState), [connectionState]);
}

export function resetTasksSyncForTest(): void {
  if (batchTimer !== null) clearTimeout(batchTimer);
  batchTimer = null;
  pendingSignals = new Map();
  trailingRefreshes.clear();
  patching.clear();
  repatch.clear();
  connection = null;
}
