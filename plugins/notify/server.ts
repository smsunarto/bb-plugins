// @smsunarto/bb-plugin-notify — desktop notifications for BB thread lifecycle events.
//
// BB notifies agents (parent threads, workflow completions) but never notifies
// the person. This plugin closes that gap: it listens to thread.idle and
// thread.failed and posts a native desktop notification, and it gives agents a
// `notify_user` tool plus a `bb notify` command for the same thing on demand.
//
// There is exactly one delivery path: the BB app window posts the notification
// itself. macOS credits a notification to the process that posted it, so this
// is the only way it can carry BB's icon, BB's name, and a click that opens
// the thread. Scripted notifiers (osascript, terminal-notifier) were tried and
// removed — they can only ever arrive as the interpreter, and an alternative
// that is worse in every respect is not worth a settings row. When no window
// is open the notification waits in a short queue and arrives when one opens.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  isThreadId,
  notificationLines,
  oneLine,
  parseSeconds,
  parseSendArgs,
  plainText,
  suppressionReason,
  threadLabel,
} from "./server/format";
import { latestRunWasManuallyStopped } from "./server/lifecycle";
import { NotificationQueue, QUEUE_MAX, type NotificationInput } from "./server/queue";
import { playSound, resolveSound, SOUND_OFF, SOUND_OPTIONS } from "./server/sound";

const BODY_MAX_CHARS = 160;
/** How long a long-poll is held open before returning an empty batch. */
const POLL_HOLD_MS = 25_000;
/** A window that polled this recently still counts as able to display. */
const RENDERER_TTL_MS = 40_000;
/** Two events about one thread inside this window collapse into the first. */
const DEDUPE_WINDOW_MS = 3_000;
/** Bounds the in-memory per-thread maps on a long-lived server. */
const MAX_TRACKED_THREADS = 500;
/** How long a cached project name is trusted before it is read again. */
const PROJECT_NAME_TTL_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default async function plugin(bb: BbPluginApi) {
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

  // configure() is synchronous, so the latest values are mirrored here rather
  // than awaited per resolution.
  let current = await settings.get();
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

  bb.http.route("GET", "/pending", async (context) => {
    const { signal } = context.req.raw;
    lastPollAt = Date.now();
    let delivery = await notifications.lease();
    if (delivery.lease === null) {
      const holdMs = Math.min(POLL_HOLD_MS, delivery.retryAfterMs ?? POLL_HOLD_MS);
      await waitForQueue(signal, holdMs);
      // Do not acquire a lease for a response whose client has already gone.
      if (signal.aborted) {
        return context.json({ leaseId: null, notifications: [] });
      }
      delivery = await notifications.lease();
    }
    lastPollAt = Date.now();
    return context.json({
      leaseId: delivery.lease?.id ?? null,
      notifications: delivery.lease?.notifications ?? [],
    });
  });

  bb.http.route("POST", "/ack", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const leaseId = isRecord(body) ? body.leaseId : undefined;
    const notificationIds = isRecord(body) ? body.notificationIds : undefined;
    if (
      typeof leaseId !== "string" ||
      leaseId === "" ||
      leaseId.length > 128 ||
      !Array.isArray(notificationIds) ||
      notificationIds.length > QUEUE_MAX ||
      notificationIds.some((id) => !Number.isSafeInteger(id) || (id as number) < 1)
    ) {
      return context.json({ ok: false, error: "invalid acknowledgement" }, 400);
    }
    const result = await notifications.acknowledge(leaseId, notificationIds as number[]);
    const sound = result.play;
    if (sound !== null) {
      // One tone per acknowledged batch, serialized so a group of completed
      // threads does not launch overlapping afplay processes.
      soundPlayback = soundPlayback.then(() => playSound(sound));
    }
    return context.json({ ok: true, acknowledged: result.acknowledged });
  });

  // Clicking a notification routes through BB's own open action — the same one
  // `bb thread open` uses — so the thread lands in the right project and pane
  // instead of the window guessing at a URL.
  bb.http.route("POST", "/open", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const threadId =
      typeof body === "object" && body !== null
        ? (body as { threadId?: unknown }).threadId
        : undefined;
    if (typeof threadId !== "string" || !isThreadId(threadId)) {
      return context.json({ ok: false, error: "invalid threadId" }, 400);
    }
    try {
      await bb.sdk.threads.open({ threadId, file: null });
      return context.json({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bb.log.warn(`open ${threadId} failed: ${detail}`);
      return context.json({ ok: false, error: detail }, 502);
    }
  });

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
    thread: {
      id: string;
      projectId: string;
      title: string | null;
      titleFallback: string | null;
      visibility: "visible" | "hidden";
      parentThreadId: string | null;
    },
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

  bb.events.on("thread.active", ({ thread }) => {
    remember(startedAt, thread.id);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!current.notifyOnIdle) {
      startedAt.delete(thread.id);
      return;
    }
    return notifyThread(thread, "finished", lastAssistantText);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    if (!current.notifyOnFailed) {
      startedAt.delete(thread.id);
      return;
    }
    return notifyThread(thread, "failed", error);
  });

  bb.events.on("thread.deleted", ({ thread }) => forget(thread.id));
  bb.events.on("thread.archived", ({ thread }) => forget(thread.id));

  bb.agents.registerTool({
    name: "notify_user",
    description:
      "Post a desktop notification on the user's machine. Use it when the user has likely walked away and something needs them now: a long job finished, or you are blocked on a decision. Do not use it for routine progress while they are watching.",
    instructions:
      "notify_user posts a native desktop notification titled with the project and thread. Keep the message under 120 characters, lead with what the user would act on, and write plain prose — markdown syntax is stripped, not rendered.",
    experimental_statusLabels: {
      pending: "Notifying the user",
      completed: "Notified the user",
    },
    // No title parameter: the heading is always `<project> · <thread>`, the
    // same as an event notification. An agent-supplied headline would make
    // one row of the notification list look unlike all the others, and it is
    // information the reader already has.
    parameters: z.object({
      message: z.string().min(1).describe("One line the user will act on."),
    }),
    async execute({ message }, ctx) {
      let heading = "bb";
      let project: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        heading = threadLabel(thread);
        project = await projectName(thread.projectId);
      } catch {
        // Thread lookup is decoration only — still send the notification.
      }
      const listening = await post(
        project,
        heading,
        oneLine(plainText(message), BODY_MAX_CHARS),
        ctx.threadId,
      );
      return listening
        ? "Notification queued; a BB window is listening."
        : "No BB window is open; the notification will appear when one is.";
    },
  });

  bb.agents.configure(() => ({
    tools: current.agentTool ? ["notify_user"] : [],
    skills: [],
  }));

  bb.cli.register({
    name: "notify",
    summary: "Post a desktop notification through the BB app window",
    commands: [
      {
        name: "send",
        summary: "Post a notification",
        usage: 'bb notify send "<message>" [--title <text>] [--thread <id>]',
      },
      {
        name: "test",
        summary: "Post a sample notification to verify the setup",
        usage: "bb notify test",
      },
      {
        name: "status",
        summary: "Show whether a BB window is listening, and the filters",
        usage: "bb notify status",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      // An agent running `bb notify send` from inside a thread should get a
      // notification that opens that thread, without naming it.
      const invokingThread = ctx.threadId ?? null;
      const sent = (listening: boolean) =>
        listening
          ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
          : {
              exitCode: 0,
              stdout: "Held — no BB window is open. It will appear when one is.\n",
            };

      if (command === "status") {
        const held = await notifications.count();
        const lines = [
          `window:     ${windowIsListening() ? `listening (${waiters.size} polling)` : "none open — notifications will wait"}`,
          `held:       ${held}`,
          `on idle:    ${current.notifyOnIdle}`,
          `on failed:  ${current.notifyOnFailed}`,
          `children:   ${current.includeChildThreads}`,
          `hidden:     ${current.includeHiddenThreads}`,
          `min run:    ${parseSeconds(current.minRunSeconds)}s`,
          `sound:      ${current.sound}`,
          `agent tool: ${current.agentTool ? "notify_user" : "disabled"}`,
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (command === "test") {
        const project = ctx.projectId === undefined ? null : await projectName(ctx.projectId);
        return sent(
          await post(
            project,
            "bb notify",
            "Notifications are working. Click to open the thread this came from.",
            invokingThread,
          ),
        );
      }

      if (command === "send") {
        const parsed = parseSendArgs(rest);
        if (!parsed.ok) {
          return { exitCode: 2, stderr: `${parsed.error}\n` };
        }
        // Same title shape as an event notification, so a scripted one does
        // not look like it came from somewhere else.
        const project = ctx.projectId === undefined ? null : await projectName(ctx.projectId);
        return sent(
          await post(
            project,
            parsed.value.title ?? "bb",
            oneLine(plainText(parsed.value.message), BODY_MAX_CHARS),
            parsed.value.threadId ?? invokingThread,
          ),
        );
      }

      return {
        exitCode: 2,
        stderr: "usage: bb notify <send|test|status>\n",
      };
    },
  });

  bb.onDispose(async () => {
    // Release held long-polls before waiting for sound playback. Each wake
    // removes itself from the set, which Set iteration tolerates.
    wakeWaiters();
    startedAt.clear();
    notifiedAt.clear();
    projectNames.clear();
    await soundPlayback;
  });
}
