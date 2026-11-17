import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";
import { errorMessage, sdkErrorCode } from "../shared/errors";
import { sleepUnlessAborted } from "../shared/sleep";
import { liveStatusFromThread } from "./live-status";

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>(["completed"]);
export const THREAD_STATUS_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const THREAD_STATUS_IDLE_INTERVAL_MS = 60_000;

function trackedThreads(store: TasksApiStore): TaskThread[] {
  const tracked: TaskThread[] = [];
  for (const task of store.tasks.listTasks()) {
    for (const thread of store.tasks.listTaskThreads(task.id)) {
      tracked.push(thread);
    }
  }
  return tracked;
}

function statusCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  const outcome = liveStatus === "completed" ? "completed — final message posted" : "failed";
  return `Thread "${thread.title}" ${outcome} · ${thread.threadId}`;
}

function transitionThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  thread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  if (thread.liveStatus === liveStatus || TERMINAL_LIVE_STATUSES.has(thread.liveStatus)) {
    return;
  }

  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body: statusCommentBody(thread, liveStatus),
      });
    }
  });

  publishThreadsChanged(bb, thread.taskId);
  publishCommentsChanged(bb, thread.taskId);
}

function transitionTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of store.tasks.listTaskThreadsByThreadId(threadId)) {
    transitionThread(bb, store, thread, liveStatus);
  }
}

async function reconcileTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  trackedThread: TaskThread,
): Promise<void> {
  try {
    const thread = await bb.sdk.threads.get({
      threadId: trackedThread.threadId,
    });
    transitionThread(bb, store, trackedThread, liveStatusFromThread(thread));
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      transitionThread(bb, store, trackedThread, "completed");
      return;
    }
    bb.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${errorMessage(error)}`,
    );
  }
}

async function reconcileTrackedThreads(bb: BbPluginApi, store: TasksApiStore): Promise<void> {
  const nonTerminalThreads = trackedThreads(store).filter(
    (thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );

  for (const trackedThread of nonTerminalThreads) {
    await reconcileTrackedThread(bb, store, trackedThread);
  }
}

function hasNonTerminalTrackedThreads(store: TasksApiStore): boolean {
  return trackedThreads(store).some((thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus));
}

export async function registerLifecycle(bb: BbPluginApi, store: TasksApiStore): Promise<void> {
  bb.events.on("thread.created", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "working");
  });
  bb.events.on("thread.idle", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "idle");
  });
  bb.events.on("thread.failed", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "failed");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "completed");
  });
  bb.events.on("thread.archived", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "archived");
  });
  // Archived rows stay non-terminal, so the reconcile also repairs a missed unarchive.
  bb.events.on("thread.unarchived", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });

  bb.background.service("thread-status-reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        if (!hasNonTerminalTrackedThreads(store)) {
          await sleepUnlessAborted(signal, THREAD_STATUS_IDLE_INTERVAL_MS);
          continue;
        }
        await sleepUnlessAborted(signal, THREAD_STATUS_RECONCILE_INTERVAL_MS);
        if (signal.aborted) break;
        await reconcileTrackedThreads(bb, store);
      }
    },
  });

  await reconcileTrackedThreads(bb, store);
}
