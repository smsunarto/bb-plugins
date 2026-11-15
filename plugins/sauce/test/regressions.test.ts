// Regression tests for the Sauce tool bug hunt of 2026-11-13 (findings SB-01..SB-15).
// Each test states the behaviour the tool should have; each one failed on c63f34b6.
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BROWSER_IDLE_TIMEOUT_MS, browserCommand, browserEnv } from "../src/server/browser.ts";
import type { LeaseStore, SauceLease } from "../src/server/lease.ts";
import {
  SauceError,
  canvasFraction,
  createSaucePage,
  pointerRotation,
  toViewport,
  type PageState,
  type RotationReading,
  type SaucePage,
} from "../src/server/live.ts";
import { createSauceCore } from "../src/server/core.ts";
import { memoryDefaults } from "./fakes.ts";

const LIVE = "https://app.saucelabs.com/live/app-testing";
const SESSION =
  "https://app.saucelabs.com/live/mobile/dataCenters/US/devices/Samsung_Galaxy_S23_16_real_sjc1";

function memoryStore(): LeaseStore {
  let lease: SauceLease | null = null;
  return { read: () => lease, write: (next) => void (lease = next) };
}

/** A scriptable stand-in for the Sauce Live tab, answering the probes live.ts sends. */
function fakeSauce() {
  const model = {
    url: LIVE,
    device: null as string | null,
    ended: false,
    capacity: false,
    pickerOpen: false,
    canvas: { left: 726, top: 89, width: 404, height: 878 } as object | null,
    /** The network is down: navigations go nowhere. */
    offline: false,
    /** Sauce keeps Start Test disabled while the account's one slot is in use. */
    startDisabled: false,
    /** Where keystrokes go: the ADB shell box only while it has focus. */
    shellFocused: true,
    shellValue: "",
    shellKeys: [] as string[],
    deviceKeys: [] as string[],
    commands: [] as string[][],
    now: 0,
    /** Simulated cost of one agent-browser call. */
    latencyMs: 0,
    /** Simulated cost of one entry inside an agent-browser batch. */
    batchEntryMs: 0,
    hook: (_args: readonly string[]): void | Promise<void> => {},
  };
  const state = () => {
    const url = new URL(model.url);
    return {
      url: model.url,
      host: url.host,
      path: url.pathname,
      ended: model.ended,
      device: model.device,
      capacity: model.capacity,
    };
  };
  const evaluate = (script: string): unknown => {
    if (script.includes("location.host")) return state();
    if (script.includes("service=googleTree")) {
      // Google asks for the password again: the tab stays on accounts.google.com.
      model.url = "https://accounts.google.com/v3/signin/challenge/pwd";
      return true;
    }
    if (script.includes("[data-qa=search-dialog]")) return model.pickerOpen;
    if (script.includes("app-search-and-select-file-id-"))
      return [{ id: "f1", label: "Rampage/Rampage-se-dev.apk" }];
    if (script.includes('[role=tab]") ') || script.includes("Mobile Real")) return false;
    if (script.includes("[data-qa=device-table]")) {
      if (script.includes("const want")) return true;
      return [{ name: "Samsung Galaxy S23", status: "Available", os: "Android 16", screen: "6.1" }];
    }
    if (script.includes('innerText.trim() === "Start Test"'))
      return script.includes(".some(") ? true : model.startDisabled ? "disabled" : "enabled";
    if (script.includes("getBoundingClientRect")) return model.canvas;
    if (script.includes("activeElement")) return model.shellFocused;
    if (script.includes("End Session|End|Yes|Confirm")) return 0;
    if (script.includes("n.parentElement")) return null; // the shell panel's output
    if (script.includes("?.value ?? null")) return model.shellValue;
    return true;
  };
  const key = (text: string) => {
    (model.shellFocused ? model.shellKeys : model.deviceKeys).push(text);
    if (model.shellFocused)
      model.shellValue =
        text === "Backspace"
          ? ""
          : text === "Enter" || text.startsWith("Control")
            ? model.shellValue
            : model.shellValue + text;
  };
  const run = async (args: readonly string[]): Promise<Record<string, unknown>> => {
    model.commands.push([...args]);
    model.now += model.latencyMs;
    await model.hook(args);
    const [command, target] = args;
    if (command === "batch") {
      // One process; the daemon runs each entry in turn and `wait` sleeps inside it.
      for (const entry of args.slice(1).filter((arg) => !arg.startsWith("--"))) {
        const step = entry.split(" ");
        model.commands.push(step);
        model.now += model.batchEntryMs;
        if (step[0] === "wait") model.now += Number(step[1]);
        await model.hook(step);
      }
      return {};
    }
    if (command === "open" && !model.offline) model.url = target ?? model.url;
    if (command === "click" && target === "[data-qa=search-dialog-input-trigger]")
      model.pickerOpen = true;
    if (command === "find" && args.includes("Dismiss")) model.pickerOpen = false;
    if (command === "press") key(target ?? "");
    if (command === "keyboard") key(args[2] ?? "");
    return command === "eval" ? { result: evaluate(target ?? "") } : {};
  };
  const page = createSaucePage(
    { run },
    {
      sleep: async (ms) => void (model.now += ms),
      now: () => model.now,
      grayThumbnail: async () => null,
    },
  );
  return { model, page, run };
}

function toolsFor(page: SaucePage, now: () => number = () => 1_000_000) {
  const store = memoryStore();
  const tools = createSauceCore({
    page,
    store,
    defaults: memoryDefaults(),
    projectName: async () => null,
    now,
    sleep: async () => {},
    tempDir: () => mkdtemp(join(tmpdir(), "bb-sauce-bugs-")),
    save: async (threadId, name) => `/storage/${threadId}/sauce/${name}`,
    threadTitle: async (threadId) => `title of ${threadId}`,
    fileSize: async () => null,
  });
  return { tools, store };
}

const A = { threadId: "thr_a" };

async function outcome(promise: Promise<unknown>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}

// ---------------------------------------------------------------------------------------
// SB-04  sauce_status reports "ready" whenever the tab is neither signed out nor in a session
// ---------------------------------------------------------------------------------------

test("SB-04a sign_in that strands the tab on Google's sign-in page is not reported as ready", async () => {
  const { model, page } = fakeSauce();
  model.url = "https://accounts.saucelabs.com/am/XUI/#login/";
  const { tools } = toolsFor(page);
  const result = await outcome(tools.status(A, { sign_in: true }));
  // Either a signed_out error or state: "signed_out" is fine; "ready" is a lie.
  expect(model.url).toStartWith("https://accounts.google.com/");
  expect(result.ok ? (result.value as { state: string }).state : "error").not.toBe("ready");
});

test("SB-04b a tab that never reaches Sauce Live is not reported as ready", async () => {
  const { model, page } = fakeSauce();
  model.url = "chrome-error://chromewebdata/";
  model.offline = true;
  const { tools } = toolsFor(page);
  const result = await outcome(tools.status(A, {}));
  expect(model.commands.some((c) => c[0] === "open")).toBe(true);
  expect(model.url).toBe("chrome-error://chromewebdata/");
  expect(result.ok ? (result.value as { state: string }).state : "error").not.toBe("ready");
});

// ---------------------------------------------------------------------------------------
// SB-05  sauce_end / endSession gives up when the End Session button cannot be clicked
// ---------------------------------------------------------------------------------------

test("SB-05 sauce_end still frees the device when the End Session button cannot be clicked", async () => {
  const { model, page } = fakeSauce();
  const { tools, store } = toolsFor(page);
  model.hook = (args) => {
    if (args[0] === "find" && args.includes("Start Test")) {
      model.url = SESSION;
      model.device = "Samsung Galaxy S23 - Android 16";
    }
    if (args[0] === "find" && args.includes("End Session"))
      throw new Error(
        "agent-browser find failed: No element found: getByRole('button', { name: 'End Session' })",
      );
  };
  await tools.start(A, { device: "Samsung Galaxy S23" });
  expect(store.read()?.threadId).toBe("thr_a");

  const result = await outcome(tools.end(A));
  // live.ts already documents the fallback ("Leaving the session page closes its device
  // connection"), but it is only reached when the click itself succeeds.
  expect(result.ok).toBe(true);
  expect(model.url).toBe(LIVE);
  expect(store.read()).toBeNull();
});

// ---------------------------------------------------------------------------------------
// SB-06  a start that fails or is cancelled after Start Test drops the lease on a live device
// ---------------------------------------------------------------------------------------

test("SB-06a a start cancelled while the device boots does not leave an untracked session", async () => {
  const { model, page } = fakeSauce();
  const { tools } = toolsFor(page);
  const stop = new AbortController();
  model.hook = (args) => {
    // Start Test was clicked; Sauce is allocating the device and the session page is not up yet.
    if (args[0] === "find" && args.includes("Start Test")) stop.abort();
  };
  const started = await outcome(
    tools.start({ ...A, signal: stop.signal }, { device: "Samsung Galaxy S23" }),
  );
  expect(started.ok).toBe(false);
  const leftThePage = model.commands.some(
    (c, i) =>
      c[0] === "open" &&
      i > model.commands.findIndex((x) => x[0] === "find" && x.includes("Start Test")),
  );
  // Sauce finishes the start a few seconds later.
  if (!leftThePage) {
    model.url = SESSION;
    model.device = "Samsung Galaxy S23 - Android 16";
  }
  model.hook = () => {};
  const status = (await tools.status(A, {})) as { state: string };
  // session_untracked tells every thread "a person is using it; do not end it; ask the user".
  expect(status.state).not.toBe("session_untracked");
});

test("SB-06b one failed page read after Start Test does not drop the lease on the starting device", async () => {
  const { model, page } = fakeSauce();
  const { tools } = toolsFor(page);
  let clicked = false;
  let failedOnce = false;
  model.hook = (args) => {
    if (args[0] === "find" && args.includes("Start Test")) clicked = true;
    else if (
      clicked &&
      !failedOnce &&
      args[0] === "eval" &&
      (args[1] ?? "").includes("location.host")
    ) {
      failedOnce = true;
      throw new Error("agent-browser eval failed: Execution context was destroyed");
    }
  };
  const started = await outcome(tools.start(A, { device: "Samsung Galaxy S23" }));
  // The device Sauce was asked for comes up regardless of the tool's failed read.
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  const status = (await tools.status(A, {})) as { state: string };
  expect(started.ok || status.state === "session_mine").toBe(true);
});

test("SB-06c sauce_end after start_pending does not hand back a device that is still booting", async () => {
  const { model, page } = fakeSauce();
  const { tools } = toolsFor(page, () => 1_000_000 + model.now);
  // Start Test is clicked, but the session page does not show within the 150 s wait.
  const started = await outcome(tools.start(A, { device: "Samsung Galaxy S23" }));
  expect(!started.ok && (started.error as SauceError).code).toBe("start_pending");
  // sauce_start.md: "continue on session_mine, otherwise call sauce_end to free the device".
  const ended = (await tools.end(A)) as { ended: boolean; released: boolean };
  const left = model.url === LIVE && model.commands.at(-1)?.[0] === "open";
  // Nothing ended or left the starting session, so Sauce brings it up afterwards.
  if (!ended.ended && !left) {
    model.url = SESSION;
    model.device = "Samsung Galaxy S23 - Android 16";
  }
  const status = (await tools.status(A, {})) as { state: string };
  expect(status.state).not.toBe("session_untracked");
});

test("SB-09 a disabled Start Test button is reported as a Sauce condition, not a raw agent-browser error", async () => {
  const { model, page } = fakeSauce();
  const { tools } = toolsFor(page);
  model.hook = (args) => {
    if (args[0] === "find" && args.includes("Start Test"))
      // Verbatim from thr_xg3udswj7h seq 444, while an orphaned session held the slot.
      throw new Error(
        "agent-browser find failed: Element '@e3' is disabled, so the click would not reach it",
      );
  };
  const started = await outcome(tools.start(A, { device: "Samsung Galaxy S23" }));
  expect(started.ok).toBe(false);
  expect(!started.ok && started.error).toBeInstanceOf(SauceError);
});

// ---------------------------------------------------------------------------------------
// SB-07  the first screenshot after sauce_start fails with page_changed
// ---------------------------------------------------------------------------------------

test("SB-07 a screenshot taken before the device canvas renders waits for it", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  model.canvas = null;
  // The canvas mounts about a second after the session header (thr_e6qtadd8hi seq 21889).
  let probes = 0;
  model.hook = (args) => {
    if (args[0] === "eval" && (args[1] ?? "").includes("getBoundingClientRect") && ++probes >= 3)
      model.canvas = { left: 726, top: 89, width: 404, height: 878 };
    if (args[0] === "download") throw new Error("stop here: the canvas was found");
  };
  const error = await page
    .captureScreen("/tmp/bb-sauce-bugs-nonexistent/screen.png")
    .catch((e) => e);
  expect(String(error?.message)).toContain("stop here");
});

// ---------------------------------------------------------------------------------------
// SB-03  adb shell keystrokes are sent without checking that the shell box has focus
// ---------------------------------------------------------------------------------------

test("SB-03 shell input never reaches the device when the ADB shell box is not focused", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  model.shellFocused = false; // the click on `textarea` did not focus the shell box
  await page
    .shell("am start -n gg.argus.rampage/com.unity3d.player.UnityPlayerGameActivity", 2_000)
    .catch(() => {});
  // On Sauce, keys typed outside the shell box are forwarded to the phone as hardware keys.
  expect(model.deviceKeys).toEqual([]);
});

// ---------------------------------------------------------------------------------------
// SB-08  sauce_touch reports failure after a touch that landed
// ---------------------------------------------------------------------------------------

function toolsOverPage(overrides: Partial<SaucePage>, reading: RotationReading) {
  const session: PageState = {
    url: SESSION,
    kind: "session",
    device: "Samsung Galaxy S23 - Android 16",
    capacityReached: false,
  };
  const live: PageState = { url: LIVE, kind: "live", device: null, capacityReached: false };
  let current = live;
  const taps: unknown[] = [];
  const page = {
    state: async () => current,
    home: async () => current,
    startSession: async () => {
      current = session;
      return { app: "Rampage/build.apk", device: session.device!, url: SESSION };
    },
    tap: async (point: unknown) => void taps.push(point),
    captureScreen: async (path: string) => {
      await writeFile(path, new Uint8Array(32));
      return { width: 1080, height: 2340, reading, thumbnail: null };
    },
    sampleScreen: async () => null,
    requireSession: async () => current,
    ...overrides,
  } as SaucePage;
  return { ...toolsFor(page), taps };
}

test("SB-08 a touch whose follow-up screenshot fails still reports that the touch was sent", async () => {
  let shots = 0;
  const { tools, taps } = toolsOverPage(
    {
      captureScreen: async (path: string) => {
        if (++shots > 1)
          throw new SauceError(
            "page_changed",
            "The Take Screenshot control is not on the session page.",
          );
        await writeFile(path, new Uint8Array(32));
        return {
          width: 1080,
          height: 2340,
          reading: { candidates: [0, 180], best: 0, clear: true },
          thumbnail: null,
        };
      },
    } as Partial<SaucePage>,
    { candidates: [0, 180], best: 0, clear: true },
  );
  await tools.start(A, { device: "Samsung Galaxy S23" });
  await tools.look(A, {});
  const touched = await outcome(tools.tap(A, { x: 0.5, y: 0.5 }, { look: "full" }));
  expect(taps).toHaveLength(1);
  // The tap landed. An error result makes the agent tap again (a double tap on the device).
  expect(touched.ok).toBe(true);
  expect(touched.ok && touched.value).toMatchObject({
    gesture: "tap",
    after_error: { code: "page_changed" },
  });
});

// ---------------------------------------------------------------------------------------
// SB-10  an assumed rotation is described as "kept from before"
// ---------------------------------------------------------------------------------------

test("SB-10 the first screenshot of a session does not claim to keep an earlier rotation", async () => {
  const { tools } = toolsOverPage({}, { candidates: [0, 180], best: null, clear: false });
  await tools.start(A, { device: "Samsung Galaxy S23" });
  const shot = (await tools.look(A, {})) as { rotation: number; note?: string };
  expect(shot.rotation).toBe(0);
  expect(shot.note ?? "").not.toContain("kept the rotation from before");
});

// ---------------------------------------------------------------------------------------
// SB-11  x = 1 or y = 1 lands one pixel outside the canvas
// ---------------------------------------------------------------------------------------

test("SB-11 every allowed coordinate maps to a pixel inside the canvas", () => {
  const rect = { left: 726, top: 89, width: 404, height: 878 };
  for (const rotation of [0, 90, 180, 270]) {
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]) {
      const at = toViewport(point, rotation, rect);
      // getBoundingClientRect's right and bottom edges are exclusive.
      expect(at.x).toBeLessThan(rect.left + rect.width);
      expect(at.y).toBeLessThan(rect.top + rect.height);
    }
  }
});

// ---------------------------------------------------------------------------------------
// SB-12  drags run several times slower than duration_ms
// ---------------------------------------------------------------------------------------

test("SB-12 a 300 ms drag takes about 300 ms with a 100 ms agent-browser round trip", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  model.latencyMs = 100; // one process spawn; tap-only calls took 0.4-0.5 s for 5 spawns in the traces
  model.batchEntryMs = 3.5; // measured 2026-11-13: 43 batch entries added 132 ms
  let down = 0;
  let up = 0;
  model.hook = (args) => {
    if (args[0] === "mouse" && args[1] === "down") down = model.now;
    if (args[0] === "mouse" && args[1] === "up") up = model.now;
  };
  await page.drag({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 0, 300, 0);
  expect(up - down).toBeGreaterThanOrEqual(240);
  expect(up - down).toBeLessThanOrEqual(360);
  // The whole gesture is one process: the daemon paces the moves, not process spawns.
  expect(model.commands.filter((c) => c[0] === "batch")).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------
// SB-02  a 4-hour systemd runtime limit killed the shared browser mid-session
// ---------------------------------------------------------------------------------------

test("SB-02 the browser is bounded by idleness, never by a wall-clock runtime limit", () => {
  const command = browserCommand("/bin/agent-browser", ["eval", "1"], true);
  expect(command.slice(0, 5)).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect"]);
  expect(command.some((arg) => /RuntimeMax/i.test(arg))).toBe(false);
  const env = browserEnv({ profile: "/p", headedConfig: "/c" }, {});
  expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe(String(BROWSER_IDLE_TIMEOUT_MS));
  // A private namespace: a by-hand `agent-browser --session sauce-live` cannot reach this daemon.
  expect(env.AGENT_BROWSER_NAMESPACE).toBe("bb-sauce");
  expect(BROWSER_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
});

test("SB-02 a session page lost to a browser restart says so instead of a bare no_session", async () => {
  const { model, run } = fakeSauce();
  let launches = 0;
  const restarting = createSaucePage(
    { run, launches: () => launches },
    {
      sleep: async (ms) => void (model.now += ms),
      now: () => model.now,
      grayThumbnail: async () => null,
    },
  );
  model.hook = (args) => {
    if (args[0] === "find" && args.includes("Start Test")) {
      model.url = SESSION;
      model.device = "Samsung Galaxy S23 - Android 16";
    }
  };
  await restarting.startSession({ device: "Samsung Galaxy S23" });
  // The browser is killed and relaunched on the next call: an empty tab.
  launches += 1;
  model.url = LIVE;
  model.device = null;
  const error = (await restarting.tap({ x: 0.5, y: 0.5 }, 0).catch((e) => e)) as SauceError;
  expect(error.code).toBe("no_session");
  expect(error.message).toContain("browser restarted");
});

// ---------------------------------------------------------------------------------------
// SB-01  iOS reads pointer positions in a frame turned 180 degrees from the picture
// ---------------------------------------------------------------------------------------

test("SB-01 iOS takes touches through the opposite turn only for a landscape app in a portrait canvas", () => {
  const ios = "iPhone 13 - iOS 27.0";
  const portrait = { left: 726, top: 89, width: 404, height: 878 };
  const landscape = { left: 560, top: 300, width: 878, height: 404 };
  // thr_e6qtadd8hi: the picture read 90; the prompt button at (0.41, 0.82) answered only
  // to taps sent at (0.59, 0.18).
  expect(pointerRotation(90, ios, portrait)).toBe(270);
  const sent = canvasFraction({ x: 0.41, y: 0.82 }, pointerRotation(90, ios, portrait));
  const worked = canvasFraction({ x: 0.59, y: 0.18 }, 90);
  expect(sent[0]).toBeCloseTo(worked[0], 9);
  expect(sent[1]).toBeCloseTo(worked[1], 9);
  // Measured live 2026-11-13: portrait screens, and a canvas turned landscape by Rotate
  // Device, follow the picture; so does Android everywhere.
  expect(pointerRotation(0, ios, portrait)).toBe(0);
  expect(pointerRotation(90, ios, landscape)).toBe(90);
  expect(pointerRotation(90, "Samsung Galaxy S23 - Android 16", portrait)).toBe(90);
});

test("SB-01 a landscape iOS tap is sent through the turned pointer frame", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "iPhone 13 - iOS 27.0";
  await page.tap({ x: 0.41, y: 0.82 }, 90);
  const rect = { left: 726, top: 89, width: 404, height: 878 };
  const moved = model.commands.find((c) => c[0] === "mouse" && c[1] === "move");
  expect(moved?.slice(2).map(Number)).toEqual(
    Object.values(toViewport({ x: 0.59, y: 0.18 }, 90, rect)),
  );
});

test("SB-01 a landscape iOS drag is sent through the turned pointer frame at both ends", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "iPhone 13 - iOS 27.0";
  await page.drag({ x: 0.5, y: 0.995 }, { x: 0.5, y: 0.55 }, 90, 0, 0);
  const rect = { left: 726, top: 89, width: 404, height: 878 };
  const moves = model.commands.filter((c) => c[0] === "mouse" && c[1] === "move");
  const at = (point: { x: number; y: number }) => Object.values(toViewport(point, 270, rect));
  expect(moves[0]?.slice(2).map(Number)).toEqual(at({ x: 0.5, y: 0.995 }));
  expect(moves.at(-1)?.slice(2).map(Number)).toEqual(at({ x: 0.5, y: 0.55 }));
});

// ---------------------------------------------------------------------------------------
// SB-03 (cont.)  a focused shell box gets the command and nothing reaches the device
// ---------------------------------------------------------------------------------------

test("SB-03 the command is typed into the focused shell box and submitted only once it holds it", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  model.shellValue = "stale text";
  await page.shell("getprop ro.product.model", 2_000).catch(() => {});
  expect(model.deviceKeys).toEqual([]);
  expect(model.shellKeys).toEqual(["Control+a", "Backspace", "getprop ro.product.model", "Enter"]);
});

// ---------------------------------------------------------------------------------------
// SB-09 (cont.)  a disabled Start Test is the busy slot
// ---------------------------------------------------------------------------------------

test("SB-09 Start Test kept disabled reads as capacity_reached and is never clicked", async () => {
  const { model, page } = fakeSauce();
  model.startDisabled = true;
  const error = (await page
    .startSession({ device: "Samsung Galaxy S23" })
    .catch((e) => e)) as SauceError;
  expect(error.code).toBe("capacity_reached");
  expect(model.commands.some((c) => c[0] === "find" && c.includes("Start Test"))).toBe(false);
});

// ---------------------------------------------------------------------------------------
// SB-13  the device list read only Sauce's first page of 25 rows
// ---------------------------------------------------------------------------------------

function pagedTable(pages: { name: string; status: string; os: string; screen: string }[][]) {
  let current = 0;
  return {
    get current() {
      return current;
    },
    evaluate(script: string): unknown {
      if (script.includes("Go to Next Page")) {
        if (current >= pages.length - 1) return "last";
        const from = `Current Page, Page ${current + 1}`;
        current += 1;
        return `from:${from}`;
      }
      if (script.includes("aria-current=page")) return `Current Page, Page ${current + 1}`;
      if (script.includes("const want")) {
        const want = JSON.parse(script.match(/const want = (\{.*?\});/)![1]!);
        return pages[current]!.some((row) => row.name === want.name && row.os === want.os);
      }
      if (script.includes("[data-qa=device-table]")) return pages[current];
      return undefined;
    },
  };
}

test("SB-13 the device list reads every page, and a start finds a row past the first page", async () => {
  const row = (name: string, os: string) => ({ name, status: "Available", os, screen: "6.1" });
  const pages = [
    Array.from({ length: 25 }, (_, i) => row(`Samsung Galaxy S2${i % 6}`, "Android 16")),
    [row("Samsung Galaxy S25", "Android 15"), row("Samsung Galaxy S23", "Android 13")],
  ];
  for (const action of ["list", "start"] as const) {
    const table = pagedTable(pages);
    const { model, run: base } = fakeSauce();
    const clicked: string[] = [];
    const paged = createSaucePage(
      {
        run: async (args) => {
          if (args[0] === "eval") {
            const answer = table.evaluate(args[1] ?? "");
            if (answer !== undefined) {
              if ((args[1] ?? "").includes("const want")) clicked.push(`page ${table.current + 1}`);
              return { result: answer };
            }
          }
          if (args[0] === "find" && args.includes("Start Test")) {
            model.url = SESSION;
            model.device = "Samsung Galaxy S23 - Android 13";
          }
          return base(args);
        },
      },
      {
        sleep: async (ms) => void (model.now += ms),
        now: () => model.now,
        grayThumbnail: async () => null,
      },
    );
    if (action === "list") {
      const listed = await paged.listDevices("Galaxy S2");
      expect(listed.devices).toHaveLength(27);
      expect(listed.truncated).toBe(false);
    } else {
      const started = await paged.startSession({ device: "Samsung Galaxy S23", os: "Android 13" });
      expect(started.device).toBe("Samsung Galaxy S23 - Android 13");
      expect(clicked).toEqual(["page 2"]);
    }
  }
});

test("SB-13 sauce_catalog reports a cut list as truncated, not as a total", async () => {
  const { tools } = toolsOverPage(
    {
      listDevices: async () => ({ app: "Rampage/build.apk", devices: [], truncated: true }),
    } as Partial<SaucePage>,
    { candidates: [0, 180], best: 0, clear: true },
  );
  const listed: Record<string, unknown> = await tools.devices(A, { query: "Galaxy" });
  expect(listed.truncated).toBe(true);
  expect(listed.total).toBeUndefined();
});

test("SB-09 a capacity banner left from an earlier start does not block browsing", async () => {
  const { model, page } = fakeSauce();
  model.capacity = true;
  model.hook = (args) => {
    // Reloading Sauce Live clears the banner.
    if (args[0] === "open") model.capacity = false;
  };
  const listed = await page.listDevices("Galaxy S23");
  expect(listed.devices.map((d) => d.name)).toEqual(["Samsung Galaxy S23"]);
});

// ---------------------------------------------------------------------------------------
// Gestures go out as one agent-browser batch
// ---------------------------------------------------------------------------------------

test("a tap is one batch of move, down, up; a press holds between down and up", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  await page.tap({ x: 0.5, y: 0.5 }, 0);
  await page.tap({ x: 0.5, y: 0.5 }, 0, 2000);
  const batches = model.commands.filter((c) => c[0] === "batch");
  expect(batches.map((c) => c.slice(2))).toEqual([
    ["mouse move 928 528", "mouse down", "mouse up"],
    ["mouse move 928 528", "mouse down", "wait 2000", "mouse up"],
  ]);
  expect(batches.every((c) => c[1] === "--bail")).toBe(true);
});

test("a gesture that fails part-way lifts the finger before reporting the failure", async () => {
  const { model, page } = fakeSauce();
  model.url = SESSION;
  model.device = "Samsung Galaxy S23 - Android 16";
  model.hook = (args) => {
    if (args[0] === "batch") throw new Error("agent-browser batch failed: step 3 of 5");
  };
  const error = await page.drag({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 0, 300, 0).catch((e) => e);
  expect(String(error?.message)).toContain("step 3 of 5");
  expect(model.commands.at(-1)).toEqual(["mouse", "up"]);
});
