import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { BrowserCommandError, createAgentBrowserRunner, createQueue } from "./browser.ts";
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
import {
  NO_DEFAULTS,
  parseOrientation,
  type DefaultsStore,
  type ProjectDefaults,
} from "./defaults.ts";
import {
  SauceError,
  createSaucePage,
  notOnSauce,
  type DeviceKey,
  type Orientation,
  type PageState,
  type RotationReading,
  type SaucePage,
} from "./live.ts";

export type SauceCoreDeps = {
  page: SaucePage;
  store: LeaseStore;
  /** Each project's defaults for `start`. */
  defaults: DefaultsStore;
  /** A project's name, or null when bb has no such project. */
  projectName(projectId: string): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Where a command saves evidence for a thread; returns the path as the thread sees it. */
  save(threadId: string, name: string, localPath: string): Promise<string>;
  threadTitle(threadId: string): Promise<string | null>;
  tempDir(): Promise<string>;
  /** Size in bytes of a file on the bb server machine, where the Sauce browser runs; null when it is not a file there. */
  fileSize(path: string): Promise<number | null>;
};

/**
 * `signal` aborts when the calling `bb` process goes away or the plugin is disposed.
 * `projectId` is the project the calling thread belongs to, whose defaults `start` applies.
 */
export type Caller = { threadId: string; projectId?: string; signal?: AbortSignal };

/** What a wait watches for on the device screen. */
export type WaitCondition = "stable" | "changed";

/** What a wait ends on: a screen condition, or a new device-log line matching a pattern. */
export type Until = WaitCondition | { log: string };

/** How things stood before the action a wait follows: the screen, or the log's tail. */
type Before = { screen?: Uint8Array | null; log?: readonly string[] };

export type LogWaitResult = {
  condition: "log";
  pattern: string;
  met: boolean;
  waited_ms: number;
  /** The first new line that matched. */
  line?: string;
  timed_out?: true;
  note?: string;
};

export type WaitResult = {
  condition: WaitCondition;
  met: boolean;
  waited_ms: number;
  /** Screen samples compared, and the last difference measured between two of them (0 to 1). */
  samples: number;
  change?: number;
  timed_out?: true;
  note?: string;
};

export type DeviceAction = "home" | "rotate" | "restart_app";

export type GestureInput = {
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  holdMs?: number;
};

/** A key the device's keyboard takes, or Android's BACK button. */
export type KeyName = DeviceKey | "back";

/** Text or one key for the field that has focus on the device. */
export type KeysInput = { text: string } | { key: KeyName };

/** How a look captures the screen: Sauce's own screenshot, or the page's picture of it. */
export type LookKind = "full" | "fast";

export type LookInput = { label?: string; ifChanged?: boolean; fast?: boolean };

/** What follows an action on the device: optionally a wait, then optionally a look. */
export type AfterOptions = {
  wait?: Until;
  timeoutMs?: number;
  look?: LookKind;
};

/** A gesture checks its frame first. */
export type GestureOptions = AfterOptions & { frame?: number };

/** One entry of a batch. Parsed from text at the CLI; the core trusts these values. */
export type Step =
  | ({ do: "tap" | "drag"; frame?: number } & GestureInput)
  | { do: "type"; text: string }
  | { do: "key"; key: KeyName }
  | { do: "wait"; until: Until; timeoutMs?: number }
  | ({ do: "look" } & LookInput)
  | { do: "device"; action: DeviceAction };

/** A file captured inside the browser queue, saved to thread storage after the queue moves on. */
type PendingFile = { dir: string; local: string; name: string };

/** A lease without a device yet may be a start still coming up; it is not stale before this. */
const START_GRACE_MS = 3 * 60 * 1000;

/** A build of a few hundred megabytes uploads and processes within this. */
const UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;

/** Longest grep match returned inline; logcat lines can carry whole payloads. */
const MATCH_LINE_MAX = 400;

/** Pause between reads of the device log's tail while waiting on it. */
const LOG_POLL_MS = 500;

/**
 * The lines of `current` that came after `previous`. Both are windows over the same
 * growing log (Sauce's panel shows its latest ~200 lines), so the end of the previous
 * window is found inside the current one and everything after it is new. With no
 * overlap the window moved past everything seen, and every line is new.
 */
export function newLines(previous: readonly string[], current: readonly string[]): string[] {
  for (let keep = Math.min(previous.length, current.length); keep > 0; keep -= 1) {
    const from = previous.length - keep;
    for (let at = current.length - keep; at >= 0; at -= 1) {
      let same = true;
      for (let i = 0; same && i < keep; i += 1) same = current[at + i] === previous[from + i];
      if (same) return current.slice(at + keep);
    }
  }
  return [...current];
}

/** Pause between screen samples while waiting. Each sample is one browser round trip. */
const WAIT_POLL_MS = 250;
export const WAIT_DEFAULT_MS = 10_000;
export const WAIT_MAX_MS = 60_000;

/**
 * Mean per-pixel difference (0 to 1) between two grayscale samples. At or below
 * STILL_MAX the screen counts as still; at or above CHANGE_MIN it counts as changed.
 * The gap between them keeps video-stream noise from reading as either.
 *
 * Measured on a Galaxy S23 running Rampage, 2026-11-13: resting screens read 0 to
 * 0.0009, a slow loading fade 0.005, and screen changes 0.02 to 0.11. One device and
 * one app, so treat these as a starting point.
 */
export const STILL_MAX = 0.003;
export const CHANGE_MIN = 0.02;

/** Consecutive still comparisons that make a screen "stable". */
const STILL_RUN = 2;

export function difference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length / 255;
}

/** How chooseRotation settled on a rotation; each rule gets its own note. */
export type RotationRule = "measured" | "kept" | "assumed_upright" | "assumed_sideways" | "unknown";

/**
 * Sauce draws a landscape app in the portrait canvas turned this way: every measured
 * reading of that case (169 across three threads and four devices, Android and iOS,
 * on 2026-11-13) was 90, never 270.
 */
const SIDEWAYS_ROTATION = 90;

/**
 * The rotation of the canvas picture. A clear reading wins. An unclear one (the
 * screen moved during the capture, or is too plain to compare) keeps the previous
 * rotation when the screen's shape still allows it; otherwise it assumes upright for
 * a screen shaped like the canvas (apps do not run upside down) and Sauce's usual
 * turn for a landscape screen in a portrait canvas.
 */
export function chooseRotation(
  reading: RotationReading,
  previous: number | null,
): { rotation: number | null; measured: boolean; rule: RotationRule } {
  if (reading.clear && reading.best !== null)
    return { rotation: reading.best, measured: true, rule: "measured" };
  if (previous !== null && reading.candidates.includes(previous))
    return { rotation: previous, measured: false, rule: "kept" };
  if (reading.candidates[0] === 0) return { rotation: 0, measured: false, rule: "assumed_upright" };
  if (reading.candidates.includes(SIDEWAYS_ROTATION))
    return { rotation: SIDEWAYS_ROTATION, measured: false, rule: "assumed_sideways" };
  return { rotation: null, measured: false, rule: "unknown" };
}

const UNMEASURED =
  "The rotation could not be measured on this capture (the screen moved, or is too plain to compare)";
const RETRY = "If a touch lands mirrored, look again once the screen is still.";

const ROTATION_NOTES: Record<RotationRule, string | undefined> = {
  measured: undefined,
  kept: `${UNMEASURED}; kept the rotation the last look used. ${RETRY}`,
  assumed_upright: `${UNMEASURED}; assumed the app is upright. ${RETRY}`,
  assumed_sideways: `${UNMEASURED}; assumed the screen is turned sideways in Sauce's canvas, as when the app and the device are held different ways. ${RETRY}`,
  unknown:
    "The rotation could not be measured on this capture, so taps and drags will refuse. Look again once the screen is still.",
};

function statusState(page: PageState, lease: LeaseCheck["kind"]) {
  if (page.kind === "signed_out") return "signed_out";
  if (page.kind === "session") {
    if (lease === "mine") return "session_mine";
    return lease === "free" ? "session_untracked" : "session_abandoned";
  }
  return page.capacityReached ? "capacity_reached" : "ready";
}

const STATUS_NEXT = {
  signed_out: "Run `bb sauce status --sign-in` once. If it stays signed out, stop and report it.",
  session_mine:
    "Your session is live. Use `bb sauce look`, `tap`, `drag`, `wait`, `batch`; `bb sauce end` when done.",
  session_untracked:
    "A session no bb thread leased is open (a person, or a script that bypasses bb sauce). Do not end it; ask the user.",
  session_abandoned:
    "The previous holder went idle. `bb sauce start` ends its session and takes the device over.",
  capacity_reached:
    "Sauce's one live slot is in use outside this browser. Wait, then run `bb sauce status` again.",
  ready:
    "Pick a build and device with `bb sauce apps` and `bb sauce devices`, then `bb sauce start`.",
} as const;

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

function describeError(error: unknown) {
  if (error instanceof SauceError)
    return { code: error.code as string, error: error.message, hint: error.hint };
  if (error instanceof BrowserCommandError) return { code: "browser_failed", error: error.message };
  return { code: "failed", error: error instanceof Error ? error.message : String(error) };
}

export function createSauceCore(deps: SauceCoreDeps) {
  const enqueue = createQueue();
  /**
   * The upright thumbnail of each holder's latest look, for reporting whether the next
   * one changed. A full and a fast look picture the screen differently (device pixels
   * against the page's video), so only looks of the same kind are compared.
   */
  const lastLook = new Map<string, { kind: LookKind; pixels: Uint8Array }>();
  /** The log tail each holder last read with `log --new`, so the next read returns only what followed. */
  const logMark = new Map<string, readonly string[]>();

  function throwIfCancelled(ctx: Caller) {
    if (ctx.signal?.aborted)
      throw new SauceError(
        "cancelled",
        "The command was cancelled; any device it started was ended.",
      );
  }

  /** Every call drives the one shared tab in turn; a call cancelled while it waited never runs. */
  function queued<T>(ctx: Caller, work: () => Promise<T>): Promise<T> {
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

  /**
   * The lease, released first when its session is gone (Sauce ended it, or the holder
   * stopped without ending); otherwise the device would read as held for up to
   * LEASE_IDLE_MS while it sits free.
   */
  async function currentLease(threadId: string): Promise<LeaseCheck> {
    const check = checkLease(deps.store, threadId, deps.now());
    if (check.kind === "free") return check;
    const { lease } = check;
    if (lease.device === null && deps.now() - lease.acquiredAt < START_GRACE_MS) return check;
    if ((await deps.page.state()).kind === "session") return check;
    releaseLease(deps.store, lease.threadId);
    lastLook.delete(lease.threadId);
    return { kind: "free" };
  }

  /** Device commands need the caller to hold the lease; an abandoned or foreign lease is refused. */
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
        "Start one with `bb sauce start`.",
      );
    }
    const holder = await holderDescription(check.lease, check.idleMs);
    throw new SauceError(
      "held_by_other_thread",
      `Another thread holds the Sauce device: ${JSON.stringify(holder)}.`,
      check.kind === "abandoned"
        ? "That lease is abandoned; `bb sauce start` takes the device over."
        : "Wait for it (bb thread wait <thread>) or ask it to run `bb sauce end`.",
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
        "Wait for it (bb thread wait <thread>) or ask it to run `bb sauce end`.",
      );
    }
    return check;
  }

  /** A session Sauce ended on its own frees the device. */
  async function onSessionGone<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SauceError && error.code === "no_session") {
        releaseLease(deps.store, threadId);
        lastLook.delete(threadId);
      }
      throw error;
    }
  }

  /** One unit of device work for the lease holder, in its turn on the shared tab. */
  function holding<T>(ctx: Caller, work: (lease: SauceLease) => Promise<T>): Promise<T> {
    return queued(ctx, async () => {
      const lease = await requireMine(ctx.threadId);
      return onSessionGone(ctx.threadId, () => work(lease));
    });
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

  async function look(ctx: Caller, input: LookInput = {}) {
    const shot = await holding(ctx, async (lease) => {
      const dir = await deps.tempDir();
      try {
        const local = join(dir, "screen.png");
        // A fast look turns the page's picture by a rotation it cannot check, so it
        // runs only on one a full look measured; otherwise this is a full look.
        const kind: LookKind =
          input.fast && lease.measured && lease.rotation !== null ? "fast" : "full";
        let capture: { width: number; height: number; thumbnail: Uint8Array | null };
        let rotation = lease.rotation;
        let measured = lease.measured;
        // Whether this look itself read the rotation, which is what its result reports.
        let measuredNow = false;
        let note: string | undefined;
        if (kind === "fast") {
          capture = await deps.page.glanceScreen(local, lease.rotation as number);
        } else {
          const full = await deps.page.captureScreen(local);
          const chosen = chooseRotation(full.reading, lease.rotation);
          capture = full;
          rotation = chosen.rotation;
          // An unclear reading that kept a measured rotation leaves it measured.
          measuredNow = chosen.measured;
          measured = chosen.measured || (chosen.rule === "kept" && lease.measured);
          note = ROTATION_NOTES[chosen.rule];
          if (input.fast && !note)
            note = "Took a full look: a fast look needs a rotation a full look measured first.";
        }
        const before = lastLook.get(ctx.threadId);
        const change =
          before?.kind === kind && capture.thumbnail
            ? difference(before.pixels, capture.thumbnail)
            : undefined;
        // Without a picture to compare, say changed: skipping a capture must be earned.
        const changed = change === undefined || change >= CHANGE_MIN;
        const skip = input.ifChanged === true && !changed && lease.frame > 0;
        const frame = skip ? lease.frame : lease.frame + 1;
        touchLease(deps.store, { rotation, measured, frame }, deps.now());
        if (capture.thumbnail && !skip)
          lastLook.set(ctx.threadId, { kind, pixels: capture.thumbnail });
        const info = {
          frame,
          kind,
          changed,
          ...(change === undefined ? {} : { change: Math.round(change * 1000) / 1000 }),
          width: capture.width,
          height: capture.height,
          rotation,
          rotation_measured: measuredNow,
          device: lease.device,
          ...(note ? { note } : {}),
        };
        if (skip) {
          await rm(dir, { recursive: true, force: true });
          return { info, file: null };
        }
        const name = `${stamp(deps.now())}${input.label ? `-${slug(input.label)}` : ""}.png`;
        return { info, file: { dir, local, name } satisfies PendingFile };
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    });
    if (!shot.file) return shot.info;
    return { path: await persist(ctx.threadId, shot.file), ...shot.info };
  }

  /** A sample of the device area now; null when it could not be captured. */
  function sample(ctx: Caller): Promise<Uint8Array | null> {
    return holding(ctx, async () => {
      const dir = await deps.tempDir();
      try {
        const pixels = await deps.page.sampleScreen(join(dir, "sample.png"));
        // A missing sample on a live session is a rendering hiccup; on a dead one, say so.
        if (!pixels) await deps.page.requireSession();
        touchLease(deps.store, {}, deps.now());
        return pixels;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  /**
   * Polls the screen until `condition` holds or `timeoutMs` passes. A timeout is a
   * result, not an error: an animated scene may never hold still, and the caller
   * still needs to know the wait ended. `baseline` is how the screen looked before
   * whatever should change it; without one, the first sample is the baseline.
   */
  async function waitFor(
    ctx: Caller,
    condition: WaitCondition,
    timeoutMs: number,
    baseline?: Uint8Array | null,
  ): Promise<WaitResult> {
    const began = deps.now();
    const limit = Math.min(WAIT_MAX_MS, Math.max(0, timeoutMs));
    let previous = baseline ?? (await sample(ctx));
    let still = 0;
    let sampled = previous ? 1 : 0;
    let moved: number | undefined;
    const measured = () => ({
      waited_ms: deps.now() - began,
      samples: sampled,
      ...(moved === undefined ? {} : { change: Math.round(moved * 10_000) / 10_000 }),
    });
    for (;;) {
      if (deps.now() - began >= limit) {
        return {
          condition,
          met: false,
          ...measured(),
          timed_out: true,
          note:
            sampled === 0
              ? "The device screen could not be sampled; run `bb sauce look` to see it."
              : condition === "stable"
                ? "The screen kept moving. An animated scene may never hold still; look, or wait for `changed`."
                : "The screen did not change.",
        };
      }
      await deps.sleep(WAIT_POLL_MS);
      throwIfCancelled(ctx);
      const current = await sample(ctx);
      if (!current) continue;
      sampled += 1;
      if (!previous) {
        previous = current;
        continue;
      }
      moved = difference(previous, current);
      if (condition === "changed") {
        if (moved >= CHANGE_MIN) return { condition, met: true, ...measured() };
        continue;
      }
      still = moved <= STILL_MAX ? still + 1 : 0;
      if (still >= STILL_RUN) return { condition, met: true, ...measured() };
      previous = current;
    }
  }

  /** The device log's latest lines, as Sauce's Device Log panel shows them. */
  function tail(ctx: Caller): Promise<string[]> {
    return holding(ctx, async () => {
      const lines = await deps.page.logTail();
      touchLease(deps.store, {}, deps.now());
      return lines;
    });
  }

  /** Polls the device log until a line newer than `baseline` matches; a timeout is a result. */
  async function waitForLog(
    ctx: Caller,
    pattern: string,
    timeoutMs: number,
    baseline?: readonly string[],
  ): Promise<LogWaitResult> {
    const matcher = new RegExp(pattern, "i");
    const began = deps.now();
    const limit = Math.min(WAIT_MAX_MS, Math.max(0, timeoutMs));
    let previous = baseline ?? (await tail(ctx));
    for (;;) {
      if (deps.now() - began >= limit) {
        return {
          condition: "log",
          pattern,
          met: false,
          waited_ms: deps.now() - began,
          timed_out: true,
          note: "No new log line matched. The panel shows the tested app at WARN and above; `bb sauce log --grep` searches the whole log.",
        };
      }
      await deps.sleep(LOG_POLL_MS);
      throwIfCancelled(ctx);
      const current = await tail(ctx);
      const line = newLines(previous, current).find((candidate) => matcher.test(candidate));
      if (line !== undefined) {
        return {
          condition: "log",
          pattern,
          met: true,
          waited_ms: deps.now() - began,
          line: line.length > MATCH_LINE_MAX ? `${line.slice(0, MATCH_LINE_MAX)}…` : line,
        };
      }
      previous = current;
    }
  }

  /** What a wait for `until` must know from before the action it follows. */
  async function before(ctx: Caller, until: Until | undefined): Promise<Before> {
    if (until === "changed") return { screen: await sample(ctx) };
    if (typeof until === "object") return { log: await tail(ctx) };
    return {};
  }

  function waitUntil(ctx: Caller, until: Until, timeoutMs: number, from: Before = {}) {
    return typeof until === "object"
      ? waitForLog(ctx, until.log, timeoutMs, from.log)
      : waitFor(ctx, until, timeoutMs, from.screen);
  }

  /** Sends one tap, press, or drag. Its result reports only what reached the device. */
  function sendGesture(ctx: Caller, input: GestureInput, frame: number | undefined) {
    return holding(ctx, async (lease) => {
      if (lease.rotation === null || lease.frame === 0) {
        throw new SauceError(
          "no_frame",
          "No look has set the coordinate frame for this session since it started or was rotated.",
          "Run `bb sauce look` first; x and y are fractions of that image.",
        );
      }
      if (frame !== undefined && frame !== lease.frame) {
        throw new SauceError(
          "stale_frame",
          `Frame ${frame} is not the latest look (frame ${lease.frame}); its coordinates may no longer match the screen.`,
          "Read the coordinates off the latest look, or run `bb sauce look` again.",
        );
      }
      const from = { x: input.x, y: input.y };
      const hasTarget = input.toX !== undefined || input.toY !== undefined;
      const to = { x: input.toX ?? input.x, y: input.toY ?? input.y };
      if (hasTarget) {
        await deps.page.drag(from, to, lease.rotation, input.durationMs ?? 300, input.holdMs ?? 0);
      } else {
        await deps.page.tap(from, lease.rotation, input.holdMs ?? 0);
      }
      touchLease(deps.store, {}, deps.now());
      return {
        gesture: hasTarget ? "drag" : input.holdMs ? "press" : "tap",
        from,
        ...(hasTarget ? { to } : {}),
        frame: lease.frame,
      };
    });
  }

  /** Sends text or one key to the field that has focus on the device. */
  function sendKeys(ctx: Caller, input: KeysInput) {
    return holding(ctx, async (lease) => {
      if ("text" in input) {
        await deps.page.typeText(input.text);
        touchLease(deps.store, {}, deps.now());
        return { typed: input.text.length };
      }
      if (input.key === "back") {
        // BACK is a device button, not a keyboard key; only Android's shell can press it.
        if (lease.device && !/ - Android /.test(lease.device))
          throw new SauceError(
            "unsupported",
            "BACK is an Android button; this device has none.",
            "Tap the app's own back control, or swipe in from the left edge with `bb sauce drag`.",
          );
        await deps.page.shell("input keyevent 4", 20_000);
      } else {
        await deps.page.pressKey(input.key);
      }
      touchLease(deps.store, {}, deps.now());
      return { key: input.key, device: lease.device };
    });
  }

  /**
   * An action on the device, then its optional wait and look. The action has landed
   * once it returns, so a wait or look that fails afterwards is reported beside it
   * rather than as a failed action, which the caller would repeat.
   */
  async function act<T extends object>(
    ctx: Caller,
    label: string,
    send: () => Promise<T>,
    options: AfterOptions,
  ) {
    const from = await before(ctx, options.wait);
    const sent = await send();
    if (!options.wait && !options.look) return sent;
    try {
      const waited = options.wait
        ? await waitUntil(ctx, options.wait, options.timeoutMs ?? WAIT_DEFAULT_MS, from)
        : undefined;
      const seen = options.look
        ? await look(ctx, { label: `after-${label}`, fast: options.look === "fast" })
        : undefined;
      return { ...sent, ...(waited ? { wait: waited } : {}), ...(seen ? { look: seen } : {}) };
    } catch (error) {
      if (
        error instanceof SauceError &&
        (error.code === "no_session" || error.code === "cancelled")
      )
        throw error;
      return { ...sent, after_error: describeError(error) };
    }
  }

  function gesture(ctx: Caller, input: GestureInput, options: GestureOptions = {}) {
    const isDrag = input.toX !== undefined || input.toY !== undefined;
    return act(
      ctx,
      isDrag ? "drag" : input.holdMs ? "press" : "tap",
      () => sendGesture(ctx, input, options.frame),
      options,
    );
  }

  /**
   * Holds a session that just started the way the command or the caller's project
   * asks. The session is already live and leased, so a device that will not turn is
   * reported on the start rather than failing it.
   */
  async function orient(ctx: Caller, asked: Orientation | undefined) {
    const fromProject = ctx.projectId ? deps.defaults.read(ctx.projectId).orientation : null;
    const orientation = asked ?? fromProject;
    if (!orientation) return {};
    const source = asked ? "option" : "project_default";
    try {
      await deps.page.orient(orientation);
      return { orientation, orientation_from: source };
    } catch (error) {
      if (!(error instanceof SauceError) && !(error instanceof BrowserCommandError)) throw error;
      return {
        orientation_note: `The device was not turned ${orientation} (${source === "option" ? "--orientation" : "this project's default"}): ${error.message} Check with \`bb sauce look\`; \`bb sauce device rotate\` turns it.`,
      };
    }
  }

  /** Shows a project's defaults, after changing those `change` names. */
  async function defaults(input: { projectId: string; change?: Partial<ProjectDefaults> }) {
    const name = await deps.projectName(input.projectId);
    if (name === null)
      throw new SauceError(
        "not_found",
        `bb has no project ${input.projectId}.`,
        "Give a project id from `bb project list`.",
      );
    const current = deps.defaults.read(input.projectId);
    const next = { ...current, ...input.change };
    if (input.change) deps.defaults.write(input.projectId, next);
    return {
      project: name,
      project_id: input.projectId,
      orientation: next.orientation,
      note: next.orientation
        ? `\`bb sauce start\` from this project's threads turns the device ${next.orientation}; \`--orientation\` overrides it for one session.`
        : "No default: `bb sauce start` leaves the device as Sauce starts it, portrait.",
    };
  }

  async function device(ctx: Caller, input: { action: DeviceAction }) {
    return holding(ctx, async () => {
      switch (input.action) {
        case "home":
          await deps.page.clickMenu("Home");
          // The home screen may be turned differently from the app.
          touchLease(deps.store, { measured: false }, deps.now());
          return { done: "home" };
        case "restart_app":
          await deps.page.clickMenu("Restart App");
          touchLease(deps.store, { measured: false }, deps.now());
          return {
            done: "restart_app",
            next: "Wait for the app to relaunch (`bb sauce wait changed`), then look.",
          };
        case "rotate":
          await deps.page.clickMenu("Rotate Device");
          touchLease(deps.store, { rotation: null, measured: false }, deps.now());
          return {
            done: "rotate",
            next: "Run `bb sauce look` to set the new coordinate frame before touching.",
          };
      }
    });
  }

  async function runStep(ctx: Caller, step: Step, frame: number | undefined, from: Before) {
    switch (step.do) {
      case "tap":
      case "drag":
        // A frame on the step itself is the caller's own check and wins over the batch's.
        return sendGesture(ctx, step, step.frame ?? frame);
      case "type":
        return sendKeys(ctx, { text: step.text });
      case "key":
        return sendKeys(ctx, { key: step.key });
      case "wait":
        return waitUntil(ctx, step.until, step.timeoutMs ?? WAIT_DEFAULT_MS, from);
      case "look":
        return look(ctx, step);
      case "device":
        return device(ctx, step);
    }
  }

  return {
    async status(ctx: Caller, input: { sign_in?: boolean } = {}) {
      return queued(ctx, async () => {
        const check = await currentLease(ctx.threadId);
        if (check.kind === "held") {
          const page = await deps.page.state();
          return {
            state: "held_by_other_thread",
            holder: await holderDescription(check.lease, check.idleMs),
            page: page.kind,
            next: "Wait for the holder (bb thread wait <thread>) or ask it to run `bb sauce end`; do not take the device.",
          };
        }
        let page = await deps.page.home();
        if (page.kind === "signed_out" && input.sign_in) page = await deps.page.signIn();
        // `ready` promises a signed-in Sauce Live page; anything else is not ready.
        if (page.kind === "other") throw notOnSauce(page);
        const lease = check.kind === "mine" ? check.lease : null;
        const state = statusState(page, check.kind);
        return {
          state,
          // Hunt prompts written for the manual route ask to check Sauce in a local
          // Chrome; say plainly that this is that browser so no second one is opened.
          browser:
            state === "signed_out"
              ? undefined
              : `Signed-in Sauce Live in Chrome on ${hostname()}, the bb server. This is the Sauce web UI route; do not open another browser or use computer use for Sauce.`,
          device: page.device,
          lease: lease
            ? { device: lease.device, frame: lease.frame, rotation: lease.rotation }
            : null,
          abandoned_lease:
            check.kind === "abandoned"
              ? await holderDescription(check.lease, check.idleMs)
              : undefined,
          next: STATUS_NEXT[state],
        };
      });
    },

    async apps(ctx: Caller, input: { query?: string } = {}) {
      return queued(ctx, async () => {
        await requireBrowsable(ctx.threadId);
        const apps = await deps.page.listApps(input.query);
        return { apps: apps.slice(0, 40), newest_first: true };
      });
    },

    /**
     * Uploads a build file to Sauce app storage. The browser that uploads it runs on
     * the bb server machine, so the file is read there.
     */
    async upload(ctx: Caller, input: { path: string }) {
      const bytes = await deps.fileSize(input.path);
      if (bytes === null) {
        throw new SauceError(
          "not_found",
          `${input.path} is not a file on ${hostname()}, the bb server machine.`,
          "The Sauce browser uploads from that machine. Give a path that exists there; a thread on another host copies the file over first.",
        );
      }
      return queued(ctx, async () => {
        await requireBrowsable(ctx.threadId);
        const app = await deps.page.uploadApp(input.path, basename(input.path), UPLOAD_TIMEOUT_MS);
        return {
          uploaded: app.label,
          id: app.id,
          megabytes: Math.round(bytes / 100_000) / 10,
          next: "Pass text from this label as --app to `bb sauce devices` and `bb sauce start`.",
        };
      });
    },

    async devices(ctx: Caller, input: { query: string; app?: string }) {
      return queued(ctx, async () => {
        await requireBrowsable(ctx.threadId);
        const { app, devices, truncated } = await deps.page.listDevices(input.query, input.app);
        const shown = Math.min(devices.length, 60);
        return {
          app,
          devices: devices.slice(0, 60),
          shown,
          ...(truncated
            ? {
                truncated: true,
                note: "Sauce lists more devices than were read; narrow the query.",
              }
            : { total: devices.length }),
          ...(!truncated && shown < devices.length
            ? { note: "Only the first 60 are shown; narrow the query." }
            : {}),
        };
      });
    },

    async start(
      ctx: Caller,
      input: { device: string; os?: string; app?: string; orientation?: Orientation },
    ) {
      return queued(ctx, async () => {
        const check = await requireBrowsable(ctx.threadId);
        const page = await deps.page.state();
        if (page.kind === "session") {
          if (check.kind === "mine") {
            throw new SauceError(
              "session_active",
              `This thread already has a live session on ${page.device ?? "a device"}.`,
              "Run `bb sauce end` before starting another device.",
            );
          }
          if (check.kind === "free") {
            throw new SauceError(
              "session_active",
              `A session on ${page.device ?? "a device"} that no bb thread leased is open in the Sauce browser.`,
              "A person or a script outside bb sauce is using it. Ask the user before ending it.",
            );
          }
          // An abandoned holder's session would otherwise keep the account's one slot busy.
          await deps.page.endSession();
        }
        throwIfCancelled(ctx);
        acquireLease(deps.store, ctx.threadId, deps.now());
        lastLook.delete(ctx.threadId);
        logMark.delete(ctx.threadId);
        try {
          const started = await deps.page.startSession(input, ctx.signal);
          // Stopped while the device came up: nobody will drive it, so hand it back.
          throwIfCancelled(ctx);
          touchLease(
            deps.store,
            { device: started.device, rotation: null, measured: false, frame: 0 },
            deps.now(),
          );
          return {
            device: started.device,
            app: started.app,
            session_url: started.url,
            ...(await orient(ctx, input.orientation)),
            lease_idle_minutes: LEASE_IDLE_MS / 60_000,
            next: "The app installs and launches over 20-60 s. Run `bb sauce look` before any tap: it sets the coordinate frame.",
          };
        } catch (error) {
          // Start Test was clicked: the session may still come up, so the lease stays
          // with this thread rather than leaving a session no thread may end.
          if (error instanceof SauceError && error.code === "start_pending") {
            touchLease(deps.store, {}, deps.now());
            throw error;
          }
          if (error instanceof SauceError && error.code === "cancelled") {
            // The page aborted a start it had set going; a session that came up anyway ends here.
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

    defaults,

    look,

    tap(ctx: Caller, input: { x: number; y: number; holdMs?: number }, options?: GestureOptions) {
      return gesture(ctx, input, options);
    },

    drag(
      ctx: Caller,
      input: Required<Pick<GestureInput, "x" | "y" | "toX" | "toY">> &
        Pick<GestureInput, "durationMs" | "holdMs">,
      options?: GestureOptions,
    ) {
      return gesture(ctx, input, options);
    },

    type(ctx: Caller, input: { text: string }, options: AfterOptions = {}) {
      return act(ctx, "type", () => sendKeys(ctx, input), options);
    },

    key(ctx: Caller, input: { key: KeyName }, options: AfterOptions = {}) {
      return act(ctx, `key-${input.key}`, () => sendKeys(ctx, input), options);
    },

    wait(ctx: Caller, input: { until: Until; timeoutMs?: number }) {
      return waitUntil(ctx, input.until, input.timeoutMs ?? WAIT_DEFAULT_MS);
    },

    device,

    async shell(ctx: Caller, input: { command: string }) {
      return holding(ctx, async () => {
        const output = await deps.page.shell(input.command, 20_000);
        touchLease(deps.store, {}, deps.now());
        const truncated = output.length > 8000;
        return {
          command: input.command,
          output: truncated ? `${output.slice(0, 8000)}\n…` : output,
          truncated,
        };
      });
    },

    /**
     * The device log. By default the whole log (Sauce's last 50,000 lines) is saved to
     * thread storage. `fresh` instead reads the panel's live tail and returns only the
     * lines since this thread's previous fresh read: cheap enough to run after a step.
     */
    async log(ctx: Caller, input: { grep?: string; fresh?: boolean } = {}) {
      let pattern: RegExp | undefined;
      if (input.grep) {
        try {
          pattern = new RegExp(input.grep, "i");
        } catch {
          throw new SauceError(
            "not_found",
            `--grep is not a valid regular expression: ${input.grep}`,
          );
        }
      }
      const clip = (line: string) =>
        line.length > MATCH_LINE_MAX ? `${line.slice(0, MATCH_LINE_MAX)}…` : line;
      if (input.fresh) {
        const current = await tail(ctx);
        const marked = logMark.get(ctx.threadId);
        const fresh = marked ? newLines(marked, current) : current;
        logMark.set(ctx.threadId, current);
        const kept = pattern ? fresh.filter((line) => pattern.test(line)) : fresh;
        return {
          new_lines: fresh.length,
          since: marked ? "this thread's previous `log --new`" : "the start of the panel's tail",
          ...(pattern
            ? { matches: kept.slice(-100).map(clip) }
            : { lines: kept.slice(-100).map(clip) }),
        };
      }
      const done = await holding(ctx, async () => {
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
                .map(clip)
            : undefined;
          return {
            result: { lines: lines.length, matches },
            file: { dir, local, name: `${stamp(deps.now())}-device.log` } satisfies PendingFile,
          };
        } catch (error) {
          await rm(dir, { recursive: true, force: true });
          throw error;
        }
      });
      return { path: await persist(ctx.threadId, done.file), ...done.result };
    },

    /**
     * Runs steps in order and stops at the first failure. Each step takes its own
     * turn on the shared tab. The whole run is also saved to thread storage: the CLI
     * prints nothing until a command ends, so a caller killed mid-run reads the record.
     */
    async batch(ctx: Caller, steps: readonly Step[], options: { frame?: number } = {}) {
      const results: unknown[] = [];
      let failed: { step: number; code: string; error: string; hint?: string } | undefined;
      // Coordinates given with the batch belong to `frame` until a look inside it sets a new one.
      let frame = options.frame;
      let from: Before = {};
      for (const [index, step] of steps.entries()) {
        try {
          throwIfCancelled(ctx);
          const isAction =
            step.do === "tap" || step.do === "drag" || step.do === "type" || step.do === "key";
          // A wait right after an action compares with the screen or log before it.
          const next = steps[index + 1];
          if (isAction && next?.do === "wait") from = await before(ctx, next.until);
          results.push(await runStep(ctx, step, frame, step.do === "wait" ? from : {}));
          if (step.do === "look") frame = undefined;
          if (!isAction) from = {};
        } catch (error) {
          failed = { step: index + 1, ...describeError(error) };
          break;
        }
      }
      const summary = {
        ok: failed === undefined,
        completed: results.length,
        total: steps.length,
        steps: results,
        ...(failed ? { failed } : {}),
      };
      const dir = await deps.tempDir();
      const local = join(dir, "batch.json");
      await writeFile(
        local,
        JSON.stringify({ at: new Date(deps.now()).toISOString(), ...summary }, null, 1),
      );
      const record = await persist(ctx.threadId, {
        dir,
        local,
        name: `${stamp(deps.now())}-batch.json`,
      }).catch(() => null);
      return { ...summary, ...(record ? { record } : {}) };
    },

    async end(ctx: Caller) {
      return queued(ctx, async () => {
        // The holder ends its own lease even when Sauce already ended the session.
        const own = checkLease(deps.store, ctx.threadId, deps.now());
        const check = own.kind === "mine" ? own : await requireBrowsable(ctx.threadId);
        if (check.kind === "free") {
          return { ended: false, released: false, note: "This thread held no Sauce device." };
        }
        lastLook.delete(check.lease.threadId);
        // A start still coming up (start_pending) has no session page yet; leaving the
        // page abandons it, so no session appears later without a lease.
        if (check.lease.device === null && (await deps.page.state()).kind !== "session") {
          const ended = await deps.page.abortStart();
          releaseLease(deps.store, check.lease.threadId);
          return { ended, released: true, note: "The start was still pending; it was abandoned." };
        }
        const ended = await deps.page.endSession();
        releaseLease(deps.store, check.lease.threadId);
        return { ended, released: true };
      });
    },
  };
}

export type SauceCore = ReturnType<typeof createSauceCore>;

/** In order; bb applies the ones a database has not seen. Append, never edit. */
export const MIGRATIONS = [
  `CREATE TABLE sauce_lease (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)`,
  `CREATE TABLE sauce_project_defaults (project_id TEXT PRIMARY KEY, orientation TEXT)`,
];

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

export function createDefaultsStore(bb: BbPluginApi): DefaultsStore {
  const db = bb.storage.database();
  return {
    read(projectId) {
      const row = db
        .prepare("SELECT orientation FROM sauce_project_defaults WHERE project_id = ?")
        .get(projectId) as { orientation: string | null } | undefined;
      return row ? { orientation: parseOrientation(row.orientation) } : NO_DEFAULTS;
    },
    write(projectId, defaults) {
      // A project with nothing set keeps no row, so a deleted project leaves none behind.
      if (defaults.orientation === null)
        db.prepare("DELETE FROM sauce_project_defaults WHERE project_id = ?").run(projectId);
      else
        db.prepare(
          "INSERT OR REPLACE INTO sauce_project_defaults (project_id, orientation) VALUES (?, ?)",
        ).run(projectId, defaults.orientation);
    },
  };
}

/** The core wired to the real Sauce browser and this bb's threads. */
export function defaultCoreDeps(bb: BbPluginApi): SauceCoreDeps {
  return {
    page: createSaucePage(createAgentBrowserRunner()),
    store: createLeaseStore(bb),
    defaults: createDefaultsStore(bb),
    projectName: (projectId) =>
      bb.sdk.projects.get({ projectId }).then(
        (project) => project.name,
        () => null,
      ),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tempDir: () => mkdtemp(join(tmpdir(), "bb-sauce-")),
    fileSize: (path) =>
      stat(path).then(
        (found) => (found.isFile() ? found.size : null),
        () => null,
      ),
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
  };
}
