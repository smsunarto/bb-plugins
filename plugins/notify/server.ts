// bb-plugin-notify — desktop notifications for BB thread lifecycle events.
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
import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  isThreadId,
  oneLine,
  parseSeconds,
  plainText,
  suppressionReason,
  threadLabel,
  notificationLines,
} from "./format";
import {
  playSound,
  resolveSound,
  SOUND_OFF,
  SOUND_OPTIONS,
} from "./sound";

const BODY_MAX_CHARS = 160;
/** How long a long-poll is held open before returning an empty batch. */
const POLL_HOLD_MS = 25_000;
/** A window that polled this recently still counts as able to display. */
const RENDERER_TTL_MS = 40_000;
/** Undelivered notifications kept for a window that is about to open. */
const QUEUE_MAX = 20;
/** News this old is no longer news; a queued notification expires. */
const QUEUE_STALE_MS = 10 * 60_000;
/** Two events about one thread inside this window collapse into the first. */
const DEDUPE_WINDOW_MS = 3_000;
/** Bounds the in-memory per-thread maps on a long-lived server. */
const MAX_TRACKED_THREADS = 500;

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
      description:
        "Lets an agent interrupt you deliberately. Off until you want that.",
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
  // One window at a time holds a long-poll open here. Notifications handed to
  // it are posted by the BB renderer, so macOS credits them to BB.

  interface QueuedNotification {
    id: number;
    title: string;
    body: string;
    threadId: string | null;
    /** Passed to the Notification; true when a tone plays instead. */
    silent: boolean;
    /** System sound to play as it is shown, or null. Never sent to the client. */
    play: string | null;
    queuedAt: number;
  }

  const queue: QueuedNotification[] = [];
  const waiters = new Set<() => void>();
  let queueSeq = 0;
  let lastPollAt = 0;

  /** True while a BB window is polling, or has polled recently enough. */
  function windowIsListening(): boolean {
    return waiters.size > 0 || Date.now() - lastPollAt < RENDERER_TTL_MS;
  }

  function enqueue(item: Omit<QueuedNotification, "id" | "queuedAt">): void {
    queueSeq += 1;
    queue.push({ ...item, id: queueSeq, queuedAt: Date.now() });
    while (queue.length > QUEUE_MAX) queue.shift();
    for (const wake of waiters) wake();
    bb.log.debug(
      `${windowIsListening() ? "queued" : "held"} — opens ${item.threadId ?? "nothing"}`,
    );
  }

  /**
   * Hand the queue to the window. The tone is played here rather than at
   * enqueue time, so a notification held while BB was closed does not chime
   * into an empty room.
   */
  function drain(): Array<Omit<QueuedNotification, "play" | "queuedAt">> {
    const cutoff = Date.now() - QUEUE_STALE_MS;
    const fresh = queue
      .splice(0, queue.length)
      .filter((item) => item.queuedAt >= cutoff);
    for (const item of fresh) {
      if (item.play !== null) void playSound(item.play);
    }
    return fresh.map(({ play: _play, queuedAt: _queuedAt, ...rest }) => rest);
  }

  function waitForQueue(signal: AbortSignal): Promise<void> {
    if (queue.length > 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      // Reachable from three directions — a new notification, the hold
      // expiring, and the client hanging up — so it guards against re-entry.
      const settle = () => {
        if (settled) return;
        settled = true;
        waiters.delete(settle);
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        resolve();
      };
      const timer = setTimeout(settle, POLL_HOLD_MS);
      signal.addEventListener("abort", settle, { once: true });
      waiters.add(settle);
    });
  }

  bb.http.route("GET", "/pending", async (context) => {
    lastPollAt = Date.now();
    await waitForQueue(context.req.raw.signal);
    lastPollAt = Date.now();
    return context.json({ notifications: drain() });
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

  bb.onDispose(() => {
    // Release any held long-poll so a reload is not stalled by it. Each wake
    // removes itself from the set, which Set iteration tolerates.
    for (const wake of waiters) wake();
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
  ): boolean {
    const { silent, play } = resolveSound(current.sound);
    const { title, body } = notificationLines(
      project,
      oneLine(threadName, 90),
      message,
    );
    enqueue({ title: oneLine(title, 90), body, threadId, silent, play });
    return windowIsListening();
  }

  const projectNames = new Map<string, string>();
  async function projectName(projectId: string): Promise<string | null> {
    const cached = projectNames.get(projectId);
    if (cached !== undefined) return cached;
    try {
      const project = await bb.sdk.projects.get({ projectId });
      projectNames.set(projectId, project.name);
      return project.name;
    } catch {
      return null;
    }
  }

  const startedAt = new Map<string, number>();
  const notifiedAt = new Map<string, number>();

  function remember(map: Map<string, number>, threadId: string): void {
    if (map.size >= MAX_TRACKED_THREADS) {
      // Insertion order: drop the oldest entry rather than growing forever.
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(threadId, Date.now());
  }

  function forget(threadId: string): void {
    startedAt.delete(threadId);
    notifiedAt.delete(threadId);
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
    remember(notifiedAt, thread.id);

    const project = await projectName(thread.projectId);
    const fallback = outcome === "failed" ? "Thread failed." : "Turn finished.";
    // The outcome used to sit on its own line. Now that the title carries
    // project and thread, only a failure earns the words.
    const said = oneLine(plainText(detail?.trim() || fallback), BODY_MAX_CHARS);
    post(
      project,
      threadLabel(thread),
      outcome === "failed" ? `Failed — ${said}` : said,
      thread.id,
    );
  }

  bb.events.on("thread.active", ({ thread }) => {
    remember(startedAt, thread.id);
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!current.notifyOnIdle) {
      startedAt.delete(thread.id);
      return;
    }
    void notifyThread(thread, "finished", lastAssistantText);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    if (!current.notifyOnFailed) {
      startedAt.delete(thread.id);
      return;
    }
    void notifyThread(thread, "failed", error);
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
      const shown = post(
        project,
        heading,
        oneLine(plainText(message), BODY_MAX_CHARS),
        ctx.threadId,
      );
      return shown
        ? "Notification shown."
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
        usage:
          'bb notify send "<message>" [--title <text>] [--thread <id>]',
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
      const sent = (shown: boolean) =>
        shown
          ? { exitCode: 0, stdout: "Shown.\n" }
          : {
              exitCode: 0,
              stdout: "Held — no BB window is open. It will appear when one is.\n",
            };

      if (command === "status") {
        const lines = [
          `window:     ${windowIsListening() ? `listening (${waiters.size} polling)` : "none open — notifications will wait"}`,
          `held:       ${queue.length}`,
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
        const project =
          ctx.projectId === undefined ? null : await projectName(ctx.projectId);
        return sent(
          post(
            project,
            "bb notify",
            "Notifications are working. Click to open the thread this came from.",
            invokingThread,
          ),
        );
      }

      if (command === "send") {
        const flags = new Map<string, string>();
        const positional: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          const token = rest[index]!;
          if (token.startsWith("--")) {
            const value = rest[index + 1];
            if (value === undefined) {
              return { exitCode: 2, stderr: `${token} needs a value\n` };
            }
            flags.set(token.slice(2), value);
            index += 1;
          } else {
            positional.push(token);
          }
        }
        const message = positional.join(" ").trim() || flags.get("message");
        if (!message) {
          return {
            exitCode: 2,
            stderr: 'usage: bb notify send "<message>" [--title <text>]\n',
          };
        }
        // Same title shape as an event notification, so a scripted one does
        // not look like it came from somewhere else.
        const project =
          ctx.projectId === undefined ? null : await projectName(ctx.projectId);
        return sent(
          post(
            project,
            flags.get("title") ?? "bb",
            oneLine(plainText(message), BODY_MAX_CHARS),
            flags.get("thread") ?? invokingThread,
          ),
        );
      }

      return {
        exitCode: 2,
        stderr: "usage: bb notify <send|test|status>\n",
      };
    },
  });

  bb.onDispose(() => {
    startedAt.clear();
    notifiedAt.clear();
    projectNames.clear();
  });
}
