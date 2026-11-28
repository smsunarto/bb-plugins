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
/** Thread reads one sweep keeps in flight; a sleeping host holds one slot, not the sweep. */
export const THREAD_STATUS_RECONCILE_CONCURRENCY = 4;

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

/** An event may have moved or removed the row while bb answered; act on what is stored now. */
function transitionCurrentRow(
  bb: BbPluginApi,
  store: TasksApiStore,
  trackedThread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  const current = store.tasks.getTaskThread(trackedThread.id);
  if (current !== undefined) transitionThread(bb, store, current, liveStatus);
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
    transitionCurrentRow(bb, store, trackedThread, liveStatusFromThread(thread));
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      transitionCurrentRow(bb, store, trackedThread, "completed");
      return;
    }
    bb.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Re-read every row bb may have moved without our hearing it, a few at a time.
 * One indexed query names them; archived, failed, and completed rows change
 * only through thread events. An aborted signal stops starting new reads.
 */
export async function reconcileTrackedThreads(
  bb: BbPluginApi,
  store: TasksApiStore,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const queue = store.tasks.listReconcilableTaskThreads();
  const next = async (): Promise<void> => {
    for (let tracked = queue.shift(); tracked !== undefined; tracked = queue.shift()) {
      if (signal.aborted) return;
      await reconcileTrackedThread(bb, store, tracked);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(THREAD_STATUS_RECONCILE_CONCURRENCY, queue.length) }, next),
  );
}

/**
 * Thread events keep task threads current. A background service reconciles
 * rows on start and every few minutes after, so plugin load never waits on bb.
 */
export function registerLifecycle(bb: BbPluginApi, store: TasksApiStore): void {
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
  // The reconcile skips archived rows, so unarchiving relies on this event.
  bb.events.on("thread.unarchived", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });

  bb.background.service("thread-status-reconcile", {
    async start(signal) {
      // The startup sweep runs here, off plugin load, so RPCs serve at once.
      await reconcileTrackedThreads(bb, store, signal);
      while (!signal.aborted) {
        if (!store.tasks.hasReconcilableTaskThreads()) {
          await sleepUnlessAborted(signal, THREAD_STATUS_IDLE_INTERVAL_MS);
          continue;
        }
        await sleepUnlessAborted(signal, THREAD_STATUS_RECONCILE_INTERVAL_MS);
        await reconcileTrackedThreads(bb, store, signal);
      }
    },
  });
}
