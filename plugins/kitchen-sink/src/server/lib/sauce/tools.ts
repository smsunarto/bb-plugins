import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { z } from "zod";

import { BrowserUnavailableError, createAgentBrowserRunner, createQueue } from "./browser.ts";
import {
  LEASE_IDLE_MS,
  acquireLease,
  checkLease,
  parseLease,
  releaseLease,
  touchLease,
  type LeaseCheck,
  type LeaseStore,
  type SauceLease,
} from "./lease.ts";
import { SauceError, createSaucePage, type RotationReading, type SaucePage } from "./live.ts";

export const SAUCE_TOOLS = [
  "sauce_status",
  "sauce_catalog",
  "sauce_start",
  "sauce_screenshot",
  "sauce_touch",
  "sauce_device",
  "sauce_end",
] as const;

/** Sauce device tools reach only threads in these projects (name or git remote). */
export const SAUCE_PROJECT_PATTERN = /rampage/i;

const text = instructionFiles(import.meta.url);

const point = z.number().min(0).max(1);

export type SauceToolDeps = {
  page: SaucePage;
  store: LeaseStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Where a tool saves evidence for a thread; returns the path as the thread sees it. */
  save(threadId: string, name: string, localPath: string): Promise<string>;
  threadTitle(threadId: string): Promise<string | null>;
  tempDir(): Promise<string>;
};

/** `signal` aborts when the call is cancelled, the thread stops, or the plugin is disposed. */
type ToolContext = { threadId: string; signal?: AbortSignal };

/** A file captured inside the browser queue, saved to thread storage after the queue moves on. */
type PendingFile = { dir: string; local: string; name: string };

/** A lease without a device yet may be a start still coming up; it is not stale before this. */
const START_GRACE_MS = 3 * 60 * 1000;

/** Longest grep match returned inline; logcat lines can carry whole payloads. */
const MATCH_LINE_MAX = 400;

type DeviceResult = { result: Record<string, unknown>; file?: PendingFile };

function ok(lines: Record<string, unknown>): PluginAgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(lines, null, 1) }] };
}

function fail(error: unknown): PluginAgentToolResult {
  if (error instanceof SauceError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            code: error.code,
            error: error.message,
            hint: error.hint,
          }),
        },
      ],
      isError: true,
    };
  }
  if (error instanceof BrowserUnavailableError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, code: "browser_unavailable", error: error.message }),
        },
      ],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: false, code: "failed", error: message }) },
    ],
    isError: true,
  };
}

/**
 * The rotation touches are mapped through. A clear reading wins. An unclear one (the
 * screen changed during the capture) keeps the previous rotation when the screen's
 * shape still allows it, assumes upright for a screen shaped like the canvas (apps
 * do not run upside down), and otherwise leaves the frame unset so touches refuse
 * rather than land mirrored.
 */
export function chooseRotation(
  reading: RotationReading,
  previous: number | null,
): { rotation: number | null; measured: boolean } {
  if (reading.clear && reading.best !== null) return { rotation: reading.best, measured: true };
  if (previous !== null && reading.candidates.includes(previous))
    return { rotation: previous, measured: false };
  if (reading.candidates[0] === 0) return { rotation: 0, measured: false };
  return { rotation: null, measured: false };
}

function stamp(now: number) {
  return new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function createSauceTools(deps: SauceToolDeps) {
  const enqueue = createQueue();

  function throwIfCancelled(ctx: ToolContext) {
    if (ctx.signal?.aborted)
      throw new SauceError(
        "cancelled",
        "The tool call was cancelled; any device it started was ended.",
      );
  }

  /** Every call drives the one shared tab in turn; a call cancelled while it waited never runs. */
  function queued<T>(ctx: ToolContext, work: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      throwIfCancelled(ctx);
      return work();
    });
  }

  async function holderDescription(lease: SauceLease, idleMs: number) {
    const title = await deps.threadTitle(lease.threadId).catch(() => null);
    return {
      thread: lease.threadId,
      title,
      device: lease.device,
      idle_minutes: Math.round(idleMs / 60_000),
    };
  }

  /** Device tools need the caller to hold the lease; an abandoned or foreign lease is refused. */
  /**
   * The lease, released first when its session is gone (Sauce ended it, or the holder
   * stopped without sauce_end); otherwise the device would read as held for up to
   * LEASE_IDLE_MS while it sits free.
   */
  async function currentLease(threadId: string): Promise<LeaseCheck> {
    const check = checkLease(deps.store, threadId, deps.now());
    if (check.kind === "free") return check;
    const { lease } = check;
    if (lease.device === null && deps.now() - lease.acquiredAt < START_GRACE_MS) return check;
    if ((await deps.page.state()).kind === "session") return check;
    releaseLease(deps.store, lease.threadId);
    return { kind: "free" };
  }

  async function requireMine(threadId: string): Promise<SauceLease> {
    const own = checkLease(deps.store, threadId, deps.now());
    // The holder learns a gone session from the page itself, with a clearer message.
    if (own.kind === "mine") return own.lease;
    const check = await currentLease(threadId);
    if (check.kind === "mine") return check.lease;
    if (check.kind === "free") {
      throw new SauceError(
        "no_session",
        "This thread holds no Sauce device.",
        "Start one with sauce_start.",
      );
    }
    const holder = await holderDescription(check.lease, check.idleMs);
    throw new SauceError(
      "held_by_other_thread",
      `Another thread holds the Sauce device: ${JSON.stringify(holder)}.`,
      check.kind === "abandoned"
        ? "That lease is abandoned; sauce_start takes the device over."
        : "Wait for it (bb thread wait <thread>) or ask it to call sauce_end.",
    );
  }

  /** Browsing pages navigates the shared tab, so only a free device or the holder may browse. */
  async function requireBrowsable(threadId: string): Promise<LeaseCheck> {
    const check = await currentLease(threadId);
    if (check.kind === "held") {
      const holder = await holderDescription(check.lease, check.idleMs);
      throw new SauceError(
        "held_by_other_thread",
        `Another thread holds the Sauce device: ${JSON.stringify(holder)}.`,
        "Wait for it (bb thread wait <thread>) or ask it to call sauce_end.",
      );
    }
    return check;
  }

  /** A session Sauce ended on its own frees the device. */
  async function onSessionGone<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SauceError && error.code === "no_session")
        releaseLease(deps.store, threadId);
      throw error;
    }
  }

  /** Runs inside the queue; the caller saves `file` with `persist` once the queue is free. */
  async function captureScreen(label: string | undefined, previous: number | null) {
    const dir = await deps.tempDir();
    try {
      const local = join(dir, "screen.png");
      const shot = await deps.page.captureScreen(local);
      const { rotation, measured } = chooseRotation(shot.reading, previous);
      const lease = touchLease(deps.store, { rotation }, deps.now());
      const name = `${stamp(deps.now())}${label ? `-${slug(label)}` : ""}.png`;
      const note =
        rotation === null
          ? "The screen changed during the capture, so its rotation is unknown and sauce_touch will refuse. Take another screenshot once the screen is still."
          : measured
            ? undefined
            : "The screen changed during the capture; kept the rotation from before. If a touch lands mirrored, take another screenshot once the screen is still.";
      return {
        file: { dir, local, name } satisfies PendingFile,
        info: {
          width: shot.width,
          height: shot.height,
          rotation,
          rotation_measured: measured,
          device: lease?.device ?? null,
          ...(note ? { note } : {}),
        },
      };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Writes a captured file to the thread's storage outside the browser queue: the
   * thread's host may be slow or asleep, and that must not stall other threads' calls.
   */
  async function persist(threadId: string, file: PendingFile): Promise<string> {
    try {
      return await deps.save(threadId, file.name, file.local);
    } finally {
      await rm(file.dir, { recursive: true, force: true });
    }
  }

  async function screenshot(ctx: ToolContext, label: string | undefined) {
    const shot = await queued(ctx, async () => {
      const lease = await requireMine(ctx.threadId);
      return onSessionGone(ctx.threadId, () => captureScreen(label, lease.rotation));
    });
    return { path: await persist(ctx.threadId, shot.file), ...shot.info };
  }

  return {
    async status(ctx: ToolContext, input: { sign_in?: boolean }) {
      return queued(ctx, async () => {
        const check = await currentLease(ctx.threadId);
        if (check.kind === "held") {
          const page = await deps.page.state();
          return {
            state: "held_by_other_thread",
            holder: await holderDescription(check.lease, check.idleMs),
            page: page.kind,
            next: "Wait for the holder (bb thread wait <thread>) or ask it to call sauce_end; do not take the device.",
          };
        }
        let page = await deps.page.home();
        if (page.kind === "signed_out" && input.sign_in) page = await deps.page.signIn();
        const lease = check.kind === "mine" ? check.lease : null;
        const untracked = page.kind === "session" && check.kind === "free";
        const state =
          page.kind === "signed_out"
            ? "signed_out"
            : page.kind === "session"
              ? lease
                ? "session_mine"
                : untracked
                  ? "session_untracked"
                  : "session_abandoned"
              : page.capacityReached
                ? "capacity_reached"
                : "ready";
        const next = {
          signed_out:
            "Call sauce_status with sign_in: true once. If it stays signed out, stop and report it.",
          session_mine:
            "Your session is live. Use sauce_screenshot, sauce_touch, sauce_device; sauce_end when done.",
          session_untracked:
            "A session no bb thread leased is open (a person, or a script that bypasses these tools). Do not end it; ask the user.",
          session_abandoned:
            "The previous holder went idle. sauce_start ends its session and takes the device over.",
          capacity_reached:
            "Sauce's one live slot is in use outside this browser. Wait, then call sauce_status again.",
          ready: "Pick a build and device with sauce_catalog, then call sauce_start.",
        }[state];
        return {
          state,
          device: page.device,
          lease: lease ? { device: lease.device, rotation: lease.rotation } : null,
          abandoned_lease:
            check.kind === "abandoned"
              ? await holderDescription(check.lease, check.idleMs)
              : undefined,
          next,
        };
      });
    },

    async catalog(
      ctx: ToolContext,
      input: { kind: "apps" | "devices"; query?: string; app?: string },
    ) {
      return queued(ctx, async () => {
        await requireBrowsable(ctx.threadId);
        if (input.kind === "apps") {
          const apps = await deps.page.listApps(input.query);
          return { apps: apps.slice(0, 40), newest_first: true };
        }
        if (!input.query) {
          throw new SauceError(
            "not_found",
            "kind: devices needs a query.",
            'Search by model, for example "Galaxy S23" or "iPhone 15".',
          );
        }
        const { app, devices } = await deps.page.listDevices(input.query, input.app);
        return {
          app,
          devices: devices.slice(0, 60),
          shown: Math.min(devices.length, 60),
          total: devices.length,
        };
      });
    },

    async start(ctx: ToolContext, input: { device: string; os?: string; app?: string }) {
      return queued(ctx, async () => {
        const check = await requireBrowsable(ctx.threadId);
        const page = await deps.page.state();
        if (page.kind === "session") {
          if (check.kind === "mine") {
            throw new SauceError(
              "session_active",
              `This thread already has a live session on ${page.device ?? "a device"}.`,
              "Call sauce_end before starting another device.",
            );
          }
          if (check.kind === "free") {
            throw new SauceError(
              "session_active",
              `A session on ${page.device ?? "a device"} that no bb thread leased is open in the Sauce browser.`,
              "A person or a script outside these tools is using it. Ask the user before ending it.",
            );
          }
          // An abandoned holder's session would otherwise keep the account's one slot busy.
          await deps.page.endSession();
        }
        throwIfCancelled(ctx);
        acquireLease(deps.store, ctx.threadId, deps.now());
        try {
          const started = await deps.page.startSession(input, ctx.signal);
          // Stopped while the device came up: nobody will drive it, so hand it back.
          throwIfCancelled(ctx);
          touchLease(deps.store, { device: started.device, rotation: null }, deps.now());
          return {
            device: started.device,
            app: started.app,
            session_url: started.url,
            lease_idle_minutes: LEASE_IDLE_MS / 60_000,
            next: "The app installs and launches over 20-60 s. Call sauce_screenshot before sauce_touch: it sets the coordinate frame.",
          };
        } catch (error) {
          // Start Test was clicked: the session may still come up, so the lease stays
          // with this thread rather than leaving a session no thread may end.
          if (error instanceof SauceError && error.code === "start_pending") {
            touchLease(deps.store, {}, deps.now());
            throw error;
          }
          if (error instanceof SauceError && error.code === "cancelled") {
            await deps.page.endSession().catch(() => false);
            releaseLease(deps.store, ctx.threadId);
            throw error;
          }
          const after = await deps.page.state().catch(() => null);
          if (after?.kind !== "session") releaseLease(deps.store, ctx.threadId);
          throw error;
        }
      });
    },

    async screenshot(ctx: ToolContext, input: { label?: string }) {
      return screenshot(ctx, input.label);
    },

    async touch(
      ctx: ToolContext,
      input: {
        x: number;
        y: number;
        to_x?: number;
        to_y?: number;
        duration_ms?: number;
        hold_ms?: number;
        screenshot_after_ms?: number;
      },
    ) {
      const touched = await queued(ctx, async () => {
        const lease = await requireMine(ctx.threadId);
        return onSessionGone(ctx.threadId, async () => {
          if (lease.rotation === null) {
            throw new SauceError(
              "no_frame",
              "No screenshot has set the coordinate frame for this session yet.",
              "Call sauce_screenshot first; x and y are fractions of that image.",
            );
          }
          const from = { x: input.x, y: input.y };
          const hasTarget = input.to_x !== undefined || input.to_y !== undefined;
          const to = { x: input.to_x ?? input.x, y: input.to_y ?? input.y };
          let gesture: string;
          if (!hasTarget && !input.hold_ms) {
            await deps.page.tap(from, lease.rotation);
            gesture = "tap";
          } else {
            await deps.page.drag(
              from,
              to,
              lease.rotation,
              input.duration_ms ?? (hasTarget ? 300 : 0),
              input.hold_ms ?? 0,
            );
            gesture = hasTarget ? "drag" : "press";
          }
          touchLease(deps.store, {}, deps.now());
          const result = { gesture, from, to: hasTarget ? to : undefined };
          if (input.screenshot_after_ms === undefined) return { result, shot: null };
          await deps.sleep(input.screenshot_after_ms);
          return { result, shot: await captureScreen("after-touch", lease.rotation) };
        });
      });
      if (!touched.shot) return touched.result;
      const path = await persist(ctx.threadId, touched.shot.file);
      return { ...touched.result, screenshot: { path, ...touched.shot.info } };
    },

    async device(
      ctx: ToolContext,
      input: {
        action: "home" | "rotate" | "restart_app" | "shell" | "log";
        command?: string;
        grep?: string;
      },
    ) {
      const done = await queued(ctx, async () => {
        await requireMine(ctx.threadId);
        return onSessionGone(ctx.threadId, async (): Promise<DeviceResult> => {
          switch (input.action) {
            case "home":
              await deps.page.clickMenu("Home");
              touchLease(deps.store, {}, deps.now());
              return { result: { done: "home" } };
            case "restart_app":
              await deps.page.clickMenu("Restart App");
              touchLease(deps.store, {}, deps.now());
              return {
                result: {
                  done: "restart_app",
                  next: "Wait for the app to relaunch, then sauce_screenshot.",
                },
              };
            case "rotate":
              await deps.page.clickMenu("Rotate Device");
              touchLease(deps.store, { rotation: null }, deps.now());
              return {
                result: {
                  done: "rotate",
                  next: "Call sauce_screenshot to set the new coordinate frame before touching.",
                },
              };
            case "shell": {
              if (!input.command)
                throw new SauceError("not_found", "action: shell needs a command.");
              const output = await deps.page.shell(input.command, 20_000);
              touchLease(deps.store, {}, deps.now());
              const truncated = output.length > 8000;
              return {
                result: {
                  command: input.command,
                  output: truncated ? `${output.slice(0, 8000)}\n…` : output,
                  truncated,
                },
              };
            }
            case "log": {
              let pattern: RegExp | undefined;
              if (input.grep) {
                try {
                  pattern = new RegExp(input.grep, "i");
                } catch {
                  throw new SauceError(
                    "not_found",
                    `grep is not a valid regular expression: ${input.grep}`,
                  );
                }
              }
              const dir = await deps.tempDir();
              try {
                const local = join(dir, "device.log");
                await deps.page.downloadLog(local);
                const lines = (await readFile(local, "utf8")).split("\n");
                touchLease(deps.store, {}, deps.now());
                const matches = pattern
                  ? lines
                      .filter((line) => pattern.test(line))
                      .slice(-100)
                      .map((line) =>
                        line.length > MATCH_LINE_MAX ? `${line.slice(0, MATCH_LINE_MAX)}…` : line,
                      )
                  : undefined;
                return {
                  result: { lines: lines.length, matches },
                  file: { dir, local, name: `${stamp(deps.now())}-device.log` },
                };
              } catch (error) {
                await rm(dir, { recursive: true, force: true });
                throw error;
              }
            }
          }
        });
      });
      if (!done.file) return done.result;
      return { path: await persist(ctx.threadId, done.file), ...done.result };
    },

    async end(ctx: ToolContext) {
      return queued(ctx, async () => {
        // The holder ends its own lease even when Sauce already ended the session.
        const own = checkLease(deps.store, ctx.threadId, deps.now());
        const check = own.kind === "mine" ? own : await requireBrowsable(ctx.threadId);
        if (check.kind === "free") {
          return { ended: false, released: false, note: "This thread held no Sauce device." };
        }
        const ended = await deps.page.endSession();
        releaseLease(deps.store, check.lease.threadId);
        return { ended, released: true };
      });
    },
  };
}

function wrap<T>(work: () => Promise<T>): Promise<PluginAgentToolResult> {
  return work().then((value) => ok(value as Record<string, unknown>), fail);
}

export function createLeaseStore(bb: BbPluginApi): LeaseStore {
  const db = bb.storage.database();
  return {
    read() {
      const row = db.prepare("SELECT payload FROM sauce_lease WHERE id = 1").get() as
        | { payload: string }
        | undefined;
      return row ? parseLease(row.payload) : null;
    },
    write(lease) {
      if (lease === null) db.prepare("DELETE FROM sauce_lease WHERE id = 1").run();
      else
        db.prepare("INSERT OR REPLACE INTO sauce_lease (id, payload) VALUES (1, ?)").run(
          JSON.stringify(lease),
        );
    },
  };
}

export function registerSauceTools(bb: BbPluginApi, overrides: Partial<SauceToolDeps> = {}) {
  const deps: SauceToolDeps = {
    page: createSaucePage(createAgentBrowserRunner()),
    store: createLeaseStore(bb),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tempDir: () => mkdtemp(join(tmpdir(), "ks-sauce-")),
    async save(threadId, name, localPath) {
      const location = await bb.sdk.threads.storageLocation({ threadId });
      const path = join(location.storageRootPath, "sauce", name);
      const content = (await readFile(localPath)).toString("base64");
      await bb.sdk.files.write({
        hostId: location.hostId,
        path,
        content,
        contentEncoding: "base64",
        createParents: true,
      });
      return path;
    },
    async threadTitle(threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      return (thread as { title?: string | null }).title ?? null;
    },
    ...overrides,
  };
  const tools = createSauceTools(deps);

  const register = (
    name: (typeof SAUCE_TOOLS)[number],
    labels: { pending: string; completed: string },
    parameters: z.ZodObject,
    execute: (input: never, ctx: ToolContext) => Promise<unknown>,
  ) => {
    const description = text.tool(name);
    bb.agents.registerTool({
      name,
      description: description.description,
      ...(description.instructions ? { instructions: description.instructions } : {}),
      presentation: { label: labels },
      parameters,
      execute: (input: unknown, ctx) => wrap(() => execute(input as never, ctx)),
    });
  };

  register(
    "sauce_status",
    { pending: "Checking Sauce Labs device", completed: "Checked Sauce Labs device" },
    z.object({
      sign_in: z
        .boolean()
        .optional()
        .describe("Click Authenticate with Google once when Sauce is signed out"),
    }),
    (input: { sign_in?: boolean }, ctx) => tools.status(ctx, input),
  );
  register(
    "sauce_catalog",
    {
      pending: "Listing Sauce Labs builds or devices",
      completed: "Listed Sauce Labs builds or devices",
    },
    z.object({
      kind: z
        .enum(["apps", "devices"])
        .describe("apps: builds in Sauce app storage; devices: real devices"),
      query: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Filter text. Required for devices, e.g. "Galaxy S23", "iPhone 15", "iPad"'),
      app: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "For devices: the build you will pass to sauce_start, as text from its label; omitted, the newest build",
        ),
    }),
    (input: { kind: "apps" | "devices"; query?: string; app?: string }, ctx) =>
      tools.catalog(ctx, input),
  );
  register(
    "sauce_start",
    { pending: "Starting a Sauce Labs real device", completed: "Started a Sauce Labs real device" },
    z.object({
      device: z
        .string()
        .min(1)
        .max(80)
        .describe('Exact device name from sauce_catalog, e.g. "Samsung Galaxy S23"'),
      os: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('OS prefix from sauce_catalog, e.g. "Android 16" or "iOS 18"'),
      app: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Text from a build label in sauce_catalog apps; omitted, the newest build"),
    }),
    (input: { device: string; os?: string; app?: string }, ctx) => tools.start(ctx, input),
  );
  register(
    "sauce_screenshot",
    { pending: "Capturing the Sauce Labs device", completed: "Captured the Sauce Labs device" },
    z.object({
      label: z.string().min(1).max(40).optional().describe("Short tag added to the file name"),
    }),
    (input: { label?: string }, ctx) => tools.screenshot(ctx, input),
  );
  register(
    "sauce_touch",
    { pending: "Touching the Sauce Labs device", completed: "Touched the Sauce Labs device" },
    z.object({
      x: point.describe("Fraction of the last screenshot's width, 0 left to 1 right"),
      y: point.describe("Fraction of the last screenshot's height, 0 top to 1 bottom"),
      to_x: point.optional().describe("Drag end x; with to_y makes a drag"),
      to_y: point.optional().describe("Drag end y"),
      duration_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("Drag travel time; default 300"),
      hold_ms: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe("Keep the finger down this long at the end"),
      screenshot_after_ms: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe("Wait this long after releasing, then take a screenshot"),
    }),
    (input: Parameters<typeof tools.touch>[1], ctx) => tools.touch(ctx, input),
  );
  register(
    "sauce_device",
    { pending: "Running a Sauce Labs device action", completed: "Ran a Sauce Labs device action" },
    z.object({
      action: z.enum(["home", "rotate", "restart_app", "shell", "log"]),
      command: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("For shell: the command after `adb shell`"),
      grep: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("For log: case-insensitive regex; returns the last 100 matching lines"),
    }),
    (input: Parameters<typeof tools.device>[1], ctx) => tools.device(ctx, input),
  );
  register(
    "sauce_end",
    { pending: "Ending the Sauce Labs session", completed: "Ended the Sauce Labs session" },
    z.object({}),
    (_input: Record<string, never>, ctx) => tools.end(ctx),
  );
}
