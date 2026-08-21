// The plugin's shared state, built once per server by `createContext` and
// handed to every RPC handler and registrar. There is exactly one delivery
// path: the BB app window posts the notification itself. macOS credits a
// notification to the process that posted it, so this is the only way it can
// carry BB's icon, BB's name, and a click that opens the thread. When no
// window is open the notification waits in a short queue and arrives when one
// opens.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  notificationLines,
  oneLine,
  parseSeconds,
  plainText,
  suppressionReason,
  threadLabel,
} from "./format.ts";
import { latestRunWasManuallyStopped } from "./lifecycle.ts";
import { NotificationQueue, type NotificationInput } from "./queue.ts";
import { playSound, resolveSound, SOUND_OFF, SOUND_OPTIONS } from "./sound.ts";

export const BODY_MAX_CHARS = 160;
/** A window that polled this recently still counts as able to display. */
const RENDERER_TTL_MS = 40_000;
/** Two events about one thread inside this window collapse into the first. */
const DEDUPE_WINDOW_MS = 3_000;
/** Bounds the in-memory per-thread maps on a long-lived server. */
const MAX_TRACKED_THREADS = 500;
/** How long a cached project name is trusted before it is read again. */
const PROJECT_NAME_TTL_MS = 5 * 60_000;

/** The settings mirror the context exposes — always read live, never held. */
export type Settings = {
  notifyOnIdle: boolean;
  notifyOnFailed: boolean;
  includeChildThreads: boolean;
  includeHiddenThreads: boolean;
  minRunSeconds: string;
  sound: string;
  agentTool: boolean;
};

/** The slice of a thread event payload `notifyThread` needs. */
export type NotifiableThread = {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  visibility: "visible" | "hidden";
  parentThreadId: string | null;
};

export type Context = {
  /** Live view of the settings mirror. Call it fresh; never keep a snapshot. */
  settings(): Settings;
  /** The durable delivery queue a window leases batches from. */
  notifications: NotificationQueue;
  /** True while a BB window is polling, or has polled recently enough. */
  windowIsListening(): boolean;
  /** How many long-polls are currently held open. */
  pollingCount(): number;
  /** Record that a window polled just now. */
  markPoll(): void;
  /** Hold until a notification arrives, the hold expires, or the client hangs up. */
  waitForQueue(signal: AbortSignal, holdMs: number): Promise<void>;
  /** Chain a named tone onto the serialized playback queue. */
  queueSound(name: string): void;
  /** Hand a notification to the window, or hold it until one opens. */
  post(
    project: string | null,
    threadName: string,
    message: string,
    threadId: string | null,
  ): Promise<boolean>;
  /** Resolve a project's display name through the TTL cache. */
  projectName(projectId: string): Promise<string | null>;
  /** Record that a thread's run started (thread.active). */
  rememberStart(threadId: string): void;
  /** Drop a thread's recorded start without notifying. */
  clearStart(threadId: string): void;
  /** Drop every trace of a deleted or archived thread. */
  forget(threadId: string): void;
  /** Notify about a finished or failed thread, applying every filter. */
  notifyThread(
    thread: NotifiableThread,
    outcome: "finished" | "failed",
    detail: string | null,
  ): Promise<void>;
};

export async function createContext(bb: BbPluginApi): Promise<Context> {
  const settings = bb.settings.define({
    notifyOnIdle: {
      type: "boolean",
      label: "Notify when a thread finishes",
      default: true,
    },
    notifyOnFailed: {
      type: "boolean",
      label: "Notify when a thread fails",
      default: true,
    },
    includeChildThreads: {
      type: "boolean",
      label: "Include child threads",
      description: "Subagent threads are noisy; off by default.",
      default: false,
    },
    includeHiddenThreads: {
      type: "boolean",
      label: "Include hidden threads",
      description: "Background plugin workers are hidden threads.",
      default: false,
    },
    minRunSeconds: {
      type: "string",
      label: "Minimum run time (seconds)",
      description:
        "Skip threads that finished faster than this. A thread whose start the plugin never saw always notifies.",
      default: "0",
    },
    sound: {
      type: "select",
      label: "Sound",
      description:
        "off is silent. system default lets macOS choose. A named tone silences the notification and plays that tone instead, so the two do not stack.",
      options: [...SOUND_OPTIONS],
      default: SOUND_OFF,
    },
    agentTool: {
      type: "boolean",
      label: "Give agents a notify_user tool",
      description: "Lets an agent interrupt you deliberately. Off until you want that.",
      default: false,
    },
  });

  // Handlers read synchronously mid-flight, so the latest values are mirrored
  // here rather than awaited per resolution.
  let current: Settings = await settings.get();
  settings.onChange((next) => {
    current = next;
    bb.log.info("settings changed");
  });

  // --- The delivery queue ---------------------------------------------------
  //
  // One window at a time holds a long-poll open here. A delivered batch stays
  // persisted under a lease until the renderer acknowledges the notifications
  // it constructed. A dropped response therefore retries instead of vanishing.
  const notifications = new NotificationQueue(bb.storage.kv);
  const waiters = new Set<() => void>();
  let lastPollAt = 0;
  let soundPlayback = Promise.resolve();

  /** True while a BB window is polling, or has polled recently enough. */
  function windowIsListening(): boolean {
    return waiters.size > 0 || Date.now() - lastPollAt < RENDERER_TTL_MS;
  }

  function wakeWaiters(): void {
    for (const wake of waiters) wake();
  }

  async function enqueue(item: NotificationInput): Promise<boolean> {
    await notifications.enqueue(item);
    const listening = windowIsListening();
    wakeWaiters();
    bb.log.debug(`${listening ? "queued" : "held"} — opens ${item.threadId ?? "nothing"}`);
    return listening;
  }

  function waitForQueue(signal: AbortSignal, holdMs: number): Promise<void> {
    if (signal.aborted || holdMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // Reachable from three directions — a new notification, the hold
      // expiring, and the client hanging up. The first one through disarms
      // the other two, so the body runs exactly once.
      const settle = () => {
        waiters.delete(settle);
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      };
      const timer = setTimeout(settle, holdMs);
      signal.addEventListener("abort", settle, { once: true });
      waiters.add(settle);
    });
  }

  /**
   * Hand a notification to the window, or hold it until one opens. The
   * project heads it and the thread takes the line below — see
   * `notificationLines`.
   */
  function post(
    project: string | null,
    threadName: string,
    message: string,
    threadId: string | null,
  ): Promise<boolean> {
    const { silent, play } = resolveSound(current.sound);
    const { title, body } = notificationLines(project, oneLine(threadName, 90), message);
    return enqueue({
      title: oneLine(title, 90),
      body: oneLine(body, BODY_MAX_CHARS),
      threadId,
      silent,
      play,
    });
  }

  // Bounded by the number of projects, which is small — the TTL is here for
  // freshness, not size. Without it a renamed project would keep tagging
  // notifications with its old name for the life of the server.
  const projectNames = new Map<string, { name: string; readAt: number }>();
  async function projectName(projectId: string): Promise<string | null> {
    const cached = projectNames.get(projectId);
    if (cached !== undefined && Date.now() - cached.readAt < PROJECT_NAME_TTL_MS) {
      return cached.name;
    }
    try {
      const project = await bb.sdk.projects.get({ projectId });
      projectNames.set(projectId, { name: project.name, readAt: Date.now() });
      return project.name;
    } catch {
      // A refresh that fails should not strip the tag off the notification;
      // the last known name is still better than no name.
      return cached?.name ?? null;
    }
  }

  const startedAt = new Map<string, number>();
  const notifiedAt = new Map<string, number>();

  function remember(map: Map<string, number>, threadId: string): void {
    // Re-setting a key does not move it in a JS Map, so a busy thread would
    // keep the position of its first sighting and be evicted ahead of threads
    // nobody has touched since. Delete first, and iteration order becomes a
    // true least-recently-seen order for the eviction below.
    map.delete(threadId);
    while (map.size >= MAX_TRACKED_THREADS) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
    map.set(threadId, Date.now());
  }

  function forget(threadId: string): void {
    startedAt.delete(threadId);
    notifiedAt.delete(threadId);
  }

  async function wasManuallyStopped(threadId: string): Promise<boolean> {
    try {
      return await latestRunWasManuallyStopped((args) =>
        bb.sdk.threads.events.list({ threadId, ...args }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bb.log.warn(`could not inspect stop reason for ${threadId}: ${detail}`);
      // Preserve the existing notification behavior when the diagnostic read
      // fails. A transient SDK error must not hide a genuine completion.
      return false;
    }
  }

  async function notifyThread(
    thread: NotifiableThread,
    outcome: "finished" | "failed",
    detail: string | null,
  ): Promise<void> {
    const suppressed = suppressionReason(thread, {
      includeHiddenThreads: current.includeHiddenThreads,
      includeChildThreads: current.includeChildThreads,
    });
    if (suppressed !== null) return;

    if (outcome === "finished" && (await wasManuallyStopped(thread.id))) {
      startedAt.delete(thread.id);
      return;
    }

    const now = Date.now();
    const lastNotified = notifiedAt.get(thread.id);
    if (lastNotified !== undefined && now - lastNotified < DEDUPE_WINDOW_MS) {
      return;
    }

    const minRunMs = parseSeconds(current.minRunSeconds) * 1000;
    const start = startedAt.get(thread.id);
    if (minRunMs > 0 && start !== undefined && now - start < minRunMs) {
      startedAt.delete(thread.id);
      return;
    }
    startedAt.delete(thread.id);
    // Reserve the dedupe window before the awaits below so idle and failed
    // events arriving together cannot both enqueue. Roll it back if delivery
    // persistence fails, allowing a later event to retry.
    remember(notifiedAt, thread.id);

    try {
      const project = await projectName(thread.projectId);
      const fallback = outcome === "failed" ? "Thread failed." : "Turn finished.";
      // The outcome used to sit on its own line. Now that the title carries
      // project and thread, only a failure earns the words.
      const said = oneLine(plainText(detail?.trim() || fallback), BODY_MAX_CHARS);
      await post(
        project,
        threadLabel(thread),
        outcome === "failed" ? `Failed — ${said}` : said,
        thread.id,
      );
    } catch (error) {
      notifiedAt.delete(thread.id);
      throw error;
    }
  }

  bb.onDispose(async () => {
    // Release held long-polls before waiting for sound playback. Each wake
    // removes itself from the set, which Set iteration tolerates.
    wakeWaiters();
    startedAt.clear();
    notifiedAt.clear();
    projectNames.clear();
    await soundPlayback;
  });

  return {
    settings: () => current,
    notifications,
    windowIsListening,
    pollingCount: () => waiters.size,
    markPoll: () => {
      lastPollAt = Date.now();
    },
    waitForQueue,
    queueSound: (name: string) => {
      // One tone per acknowledged batch, serialized so a group of completed
      // threads does not launch overlapping afplay processes.
      soundPlayback = soundPlayback.then(() => playSound(name));
    },
    post,
    projectName,
    rememberStart: (threadId: string) => {
      remember(startedAt, threadId);
    },
    clearStart: (threadId: string) => {
      startedAt.delete(threadId);
    },
    forget,
    notifyThread,
  };
}
