import {
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginCliContext,
  type PluginCliRegistration,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";

import { BrowserUnavailableError } from "./browser.ts";
import {
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  type Caller,
  type DeviceAction,
  type GestureOptions,
  type SauceCore,
  type Step,
  type WaitCondition,
} from "./core.ts";
import { SauceError } from "./live.ts";

const HOLD_MAX_MS = 30_000;
const DRAG_MAX_MS = 5_000;
const BATCH_MAX_STEPS = 40;

const json = { type: "boolean", description: "Print the result as JSON" } as const;
const frame = {
  type: "integer",
  min: 1,
  max: 1_000_000,
  description:
    "Frame id of the look the coordinates were read from; refuses with stale_frame when a newer look exists",
} as const;
const hold = {
  type: "duration",
  defaultUnit: "ms",
  min: 0,
  max: HOLD_MAX_MS,
  description: "Keep the finger down this long before lifting (max 30s)",
} as const;
const wait = {
  type: "enum",
  values: ["stable", "changed"],
  description:
    "After the gesture, wait until the screen holds still (stable) or differs from before the gesture (changed)",
} as const;
const timeout = {
  type: "duration",
  defaultUnit: "ms",
  min: 0,
  max: WAIT_MAX_MS,
  description: "Longest wait (default 10s, max 60s); a timeout is reported, not an error",
} as const;
const look = {
  type: "boolean",
  description: "Capture the screen afterwards (after the wait, when both are given)",
} as const;

const DEVICE_ACTIONS: Record<string, DeviceAction> = {
  home: "home",
  rotate: "rotate",
  "restart-app": "restart_app",
};

function usage(message: string, hint?: string): PluginCliError {
  return new PluginCliError(message, { code: "invalid_value", ...(hint ? { hint } : {}) });
}

/** A screen coordinate: a fraction of the latest look, 0 at the left or top edge, 1 at the right or bottom. */
export function fraction(text: string, name: string): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw usage(
      `${name} must be a fraction from 0 to 1, got "${text}"`,
      "Coordinates are fractions of the latest look: 0.5 0.5 is the centre of the screen.",
    );
  }
  return value;
}

/** A duration inside a batch step: `300`, `300ms`, or `2s`. A bare number is milliseconds. */
export function milliseconds(text: string, name: string, max: number): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(text);
  const value = match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : Number.NaN;
  if (!Number.isFinite(value) || value > max) {
    throw usage(`${name} must be a duration up to ${max} ms such as 500ms or 2s, got "${text}"`);
  }
  return Math.round(value);
}

function condition(text: string | undefined): WaitCondition {
  if (text === "stable" || text === "changed") return text;
  throw usage(`wait takes stable or changed, got "${text ?? ""}"`);
}

function deviceAction(text: string | undefined): DeviceAction {
  const action = DEVICE_ACTIONS[text ?? ""];
  if (!action) throw usage(`device takes home, rotate, or restart-app, got "${text ?? ""}"`);
  return action;
}

/**
 * One batch step from its text, in the same words as the standalone commands:
 * `tap .9 .1 --hold 2s`, `drag .5 .8 .5 .2 --duration 300`, `wait stable --timeout 5s`,
 * `look --label lobby --if-changed`, `device rotate`.
 */
export function parseStep(text: string): Step {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const [verb, ...rest] = tokens;
  const bare: string[] = [];
  const flags = new Map<string, string | true>();
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at] as string;
    if (!token.startsWith("--")) {
      bare.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "if-changed") flags.set(name, true);
    else flags.set(name, rest[(at += 1)] ?? "");
  }
  const allow = (...names: string[]) => {
    for (const name of flags.keys())
      if (!names.includes(name)) throw usage(`step "${text}": unknown option --${name}`);
  };
  const take = (count: number) => {
    if (bare.length !== count)
      throw usage(`step "${text}": ${verb} takes ${count} value${count === 1 ? "" : "s"}`);
  };
  const duration = (name: string, max: number) => {
    const value = flags.get(name);
    return typeof value === "string" ? milliseconds(value, `--${name}`, max) : undefined;
  };
  switch (verb) {
    case "tap": {
      allow("hold");
      take(2);
      const holdMs = duration("hold", HOLD_MAX_MS);
      return {
        do: "tap",
        x: fraction(bare[0] as string, "x"),
        y: fraction(bare[1] as string, "y"),
        ...(holdMs === undefined ? {} : { holdMs }),
      };
    }
    case "drag": {
      allow("hold", "duration");
      take(4);
      const holdMs = duration("hold", HOLD_MAX_MS);
      const durationMs = duration("duration", DRAG_MAX_MS);
      return {
        do: "drag",
        x: fraction(bare[0] as string, "x"),
        y: fraction(bare[1] as string, "y"),
        toX: fraction(bare[2] as string, "to-x"),
        toY: fraction(bare[3] as string, "to-y"),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(holdMs === undefined ? {} : { holdMs }),
      };
    }
    case "wait": {
      allow("timeout");
      take(1);
      const timeoutMs = duration("timeout", WAIT_MAX_MS);
      return {
        do: "wait",
        condition: condition(bare[0]),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
    case "look": {
      allow("label", "if-changed");
      take(0);
      const label = flags.get("label");
      return {
        do: "look",
        ...(typeof label === "string" && label ? { label } : {}),
        ...(flags.has("if-changed") ? { ifChanged: true } : {}),
      };
    }
    case "device":
      allow();
      take(1);
      return { do: "device", action: deviceAction(bare[0]) };
    default:
      throw usage(
        `step "${text}": unknown step "${verb ?? ""}"`,
        "A step is one of: tap, drag, wait, look, device.",
      );
  }
}

function gestureOptions(options: {
  frame?: number;
  wait?: string;
  timeout?: number;
  look: boolean;
}): GestureOptions {
  return {
    ...(options.frame === undefined ? {} : { frame: options.frame }),
    ...(options.wait ? { wait: condition(options.wait) } : {}),
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    look: options.look,
  };
}

/** Readable `key: value` lines; nested values indent, list entries stay on one line each. */
export function render(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return `${indent}${String(value)}`;
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry)) {
      lines.push(`${indent}${key}:${entry.length === 0 ? " []" : ""}`);
      for (const item of entry)
        lines.push(
          `${indent}  - ${item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)}`,
        );
    } else if (entry !== null && typeof entry === "object") {
      lines.push(`${indent}${key}:`, render(entry, `${indent}  `));
    } else {
      lines.push(`${indent}${key}: ${String(entry)}`);
    }
  }
  return lines.join("\n");
}

function print(value: unknown, asJson: boolean, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: asJson ? JSON.stringify(value) : render(value) };
}

/** Turns the core's errors into the CLI's coded failures; anything else is a bug and stays thrown. */
async function answer(asJson: boolean, work: () => Promise<unknown>): Promise<PluginCliResult> {
  try {
    return print(await work(), asJson);
  } catch (error) {
    if (error instanceof SauceError) {
      throw new PluginCliError(error.message, {
        code: error.code,
        ...(error.hint ? { hint: error.hint } : {}),
      });
    }
    if (error instanceof BrowserUnavailableError) {
      throw new PluginCliError(error.message, {
        code: "browser_unavailable",
        hint: "The bb server machine cannot run the Sauce browser. Report it; do not try another browser.",
      });
    }
    throw error;
  }
}

/**
 * The device lease belongs to a thread, so a caller outside one cannot hold it.
 * `bb` sends the thread id from BB_THREAD_ID, which every thread's shell carries.
 */
function caller(cli: PluginCliContext): Caller {
  if (!cli.threadId) {
    throw new PluginCliError("bb sauce runs for a bb thread, and this shell names none.", {
      code: "no_thread",
      hint: "Run it from a thread's shell, or set BB_THREAD_ID=<thread id> for the thread that should hold the device.",
    });
  }
  return { threadId: cli.threadId, ...(cli.signal ? { signal: cli.signal } : {}) };
}

export function sauceCli(core: SauceCore): PluginCliRegistration {
  return defineCli({
    name: "sauce",
    summary: "Drive a Sauce Labs real device: start, look, tap, drag, wait, batch, end",
    description:
      "One device for the whole machine, leased to the calling thread. Read the sauce-live skill before `bb sauce start`.\n" +
      "Coordinates are fractions (0 to 1) of the latest `look`, from its top-left corner.",
    commands: {
      status: cliCommand({
        summary: "Check the Sauce browser, its sign-in, and who holds the device; run this first",
        options: {
          "sign-in": {
            type: "boolean",
            description: "Click Authenticate with Google once when Sauce is signed out",
          },
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () =>
            // Reading the state needs no lease, so a shell outside a thread may ask.
            core.status(
              { threadId: cli.threadId ?? "", ...(cli.signal ? { signal: cli.signal } : {}) },
              { sign_in: input.options["sign-in"] },
            ),
          ),
      }),
      apps: cliCommand({
        summary: "List builds in Sauce app storage, newest first",
        positionals: [
          { name: "query", description: "Text to find older builds; omitted, the newest ~10" },
        ],
        options: { json },
        run: (input, cli) =>
          answer(input.options.json, () =>
            core.apps(
              caller(cli),
              input.positionals.query ? { query: input.positionals.query } : {},
            ),
          ),
      }),
      devices: cliCommand({
        summary: "List real devices that can run a build, with status, OS, and screen size",
        positionals: [
          {
            name: "query",
            description: 'Model text such as "Galaxy S23", "iPhone 15", or "iPad"',
            required: true,
          },
        ],
        options: {
          app: {
            type: "string",
            description:
              "Text from the label of the build you will start; omitted, the newest build",
          },
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () =>
            core.devices(caller(cli), {
              query: input.positionals.query,
              ...(input.options.app ? { app: input.options.app } : {}),
            }),
          ),
      }),
      start: cliCommand({
        summary: "Start a live session on one device and lease it to this thread (10 s to 3 min)",
        positionals: [
          {
            name: "device",
            description: 'Exact device name from `bb sauce devices`, e.g. "Samsung Galaxy S23"',
            required: true,
          },
        ],
        options: {
          os: {
            type: "string",
            description: 'OS prefix from `bb sauce devices`, e.g. "Android 16" or "iOS 18"',
          },
          app: {
            type: "string",
            description: "Text from a build label in `bb sauce apps`; omitted, the newest build",
          },
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () =>
            core.start(caller(cli), {
              device: input.positionals.device,
              ...(input.options.os ? { os: input.options.os } : {}),
              ...(input.options.app ? { app: input.options.app } : {}),
            }),
          ),
      }),
      look: cliCommand({
        summary: "Capture the device screen as an upright PNG and set the frame touches refer to",
        aliases: ["screenshot"],
        options: {
          label: { type: "string", description: "Short tag added to the file name" },
          "if-changed": {
            type: "boolean",
            description:
              "Save nothing and keep the current frame when the screen matches the last look",
          },
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () =>
            core.look(caller(cli), {
              ...(input.options.label ? { label: input.options.label } : {}),
              ifChanged: input.options["if-changed"],
            }),
          ),
      }),
      tap: cliCommand({
        summary: "Tap, or press and hold with --hold, at a point of the latest look",
        positionals: [
          {
            name: "x",
            description: "Fraction of the look's width, 0 left to 1 right",
            required: true,
          },
          {
            name: "y",
            description: "Fraction of the look's height, 0 top to 1 bottom",
            required: true,
          },
        ],
        options: { hold, frame, wait, timeout, look, json },
        run: (input, cli) =>
          answer(input.options.json, () => {
            // Check the arguments before the thread rule, so a typo reads as a typo.
            const point = {
              x: fraction(input.positionals.x, "x"),
              y: fraction(input.positionals.y, "y"),
              ...(input.options.hold === undefined ? {} : { holdMs: input.options.hold }),
            };
            return core.tap(caller(cli), point, gestureOptions(input.options));
          }),
      }),
      drag: cliCommand({
        summary: "Drag or swipe one finger between two points of the latest look",
        aliases: ["swipe"],
        positionals: [
          { name: "x", description: "Start, fraction of the look's width", required: true },
          { name: "y", description: "Start, fraction of the look's height", required: true },
          { name: "to-x", description: "End, fraction of the look's width", required: true },
          { name: "to-y", description: "End, fraction of the look's height", required: true },
        ],
        options: {
          duration: {
            type: "duration",
            defaultUnit: "ms",
            min: 0,
            max: DRAG_MAX_MS,
            description: "Travel time (default 300ms, max 5s)",
          },
          hold: {
            ...hold,
            description:
              "Keep the finger down at the end this long (max 30s); a joystick moves for as long as it is held",
          },
          frame,
          wait,
          timeout,
          look,
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () => {
            const path = {
              x: fraction(input.positionals.x, "x"),
              y: fraction(input.positionals.y, "y"),
              toX: fraction(input.positionals["to-x"], "to-x"),
              toY: fraction(input.positionals["to-y"], "to-y"),
              ...(input.options.duration === undefined
                ? {}
                : { durationMs: input.options.duration }),
              ...(input.options.hold === undefined ? {} : { holdMs: input.options.hold }),
            };
            return core.drag(caller(cli), path, gestureOptions(input.options));
          }),
      }),
      wait: cliCommand({
        summary: "Wait until the screen holds still (stable) or changes (changed)",
        positionals: [
          {
            name: "condition",
            description:
              "stable: two matching samples in a row; changed: differs from when the wait began",
            required: true,
          },
        ],
        options: { timeout, json },
        run: (input, cli) =>
          answer(input.options.json, () => {
            const until = condition(input.positionals.condition);
            return core.wait(caller(cli), {
              condition: until,
              timeoutMs: input.options.timeout ?? WAIT_DEFAULT_MS,
            });
          }),
      }),
      batch: cliCommand({
        summary: "Run several steps in one command, stopping at the first failure",
        description:
          'Each argument is one quoted step: "tap <x> <y> [--hold 2s]", "drag <x> <y> <to-x> <to-y> [--duration 300ms] [--hold 2s]",\n' +
          '"wait stable|changed [--timeout 10s]", "look [--label name] [--if-changed]", "device home|rotate|restart-app".\n' +
          'Example: bb sauce batch "tap 0.93 0.07" "wait stable" "look"\n' +
          "Nothing prints until the last step ends; the result and each look are also saved to thread storage.",
        positionals: [
          {
            name: "steps",
            description: `Quoted steps, run in order (max ${BATCH_MAX_STEPS})`,
            required: true,
            variadic: true,
          },
        ],
        options: {
          frame: {
            ...frame,
            description:
              "Frame id the steps' coordinates were read from; checked until a look step sets a new frame",
          },
          json,
        },
        async run(input, cli) {
          const texts = input.positionals.steps;
          if (texts.length > BATCH_MAX_STEPS)
            throw usage(`batch takes at most ${BATCH_MAX_STEPS} steps, got ${texts.length}`);
          // Parse every step before the first one runs, so a typo sends nothing to the device.
          const steps = texts.map(parseStep);
          const who = caller(cli);
          try {
            const result = await core.batch(
              who,
              steps,
              input.options.frame === undefined ? {} : { frame: input.options.frame },
            );
            return print(result, input.options.json, result.ok ? 0 : 1);
          } catch (error) {
            return answer(input.options.json, () => Promise.reject(error));
          }
        },
      }),
      device: cliCommand({
        summary: "Press Home, rotate the device, or relaunch the app under test",
        positionals: [
          {
            name: "action",
            description: "home, rotate (look again before touching), or restart-app",
            required: true,
          },
        ],
        options: { json },
        run: (input, cli) =>
          answer(input.options.json, () => {
            const action = deviceAction(input.positionals.action);
            return core.device(caller(cli), { action });
          }),
      }),
      shell: cliCommand({
        summary: "Run an adb shell command on an Android device (up to 20 s)",
        description:
          "Sauce allows a fixed list of commands such as am, dumpsys, getprop, input, grep; logcat, cat, tail and wm are refused.\n" +
          "A page_changed error saying the command was not sent means no keys reached the device; run it again.",
        positionals: [
          {
            name: "command",
            description:
              "The command after `adb shell`, as one quoted argument or after `--` (its own flags would otherwise be read as bb sauce options)",
            variadic: true,
          },
        ],
        passthrough: true,
        options: { json },
        run: (input, cli) =>
          answer(input.options.json, () => {
            const command = [...input.positionals.command, ...input.passthrough].join(" ").trim();
            if (!command)
              throw usage(
                "shell needs a command",
                "For example: bb sauce shell -- getprop ro.product.model",
              );
            return core.shell(caller(cli), { command });
          }),
      }),
      log: cliCommand({
        summary: "Save the device log (last 50,000 lines, all apps) to thread storage",
        options: {
          grep: {
            type: "string",
            description: "Case-insensitive regex; also prints the last 100 matching lines",
          },
          json,
        },
        run: (input, cli) =>
          answer(input.options.json, () =>
            core.log(caller(cli), input.options.grep ? { grep: input.options.grep } : {}),
          ),
      }),
      end: cliCommand({
        summary: "End this thread's session and release the device for other threads",
        options: { json },
        run: (input, cli) => answer(input.options.json, () => core.end(caller(cli))),
      }),
    },
  });
}
