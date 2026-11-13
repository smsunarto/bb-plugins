import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";

import plugin, { SKILLS } from "../src/server/server.ts";
import { LEASE_IDLE_MS, type LeaseStore, type SauceLease } from "../src/server/lib/sauce/lease.ts";
import {
  SauceError,
  createSaucePage,
  scoreRotation,
  toViewport,
  type PageState,
  type RotationReading,
  type SaucePage,
} from "../src/server/lib/sauce/live.ts";
import { pngGrayThumbnail, pngSize } from "../src/server/lib/sauce/png.ts";
import { SAUCE_TOOLS, createSauceTools } from "../src/server/lib/sauce/tools.ts";

// A 2340x1080 PNG header is all pngSize reads.
const PNG = (() => {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 2340);
  view.setUint32(20, 1080);
  return bytes;
})();

function memoryStore(): LeaseStore {
  let lease: SauceLease | null = null;
  return { read: () => lease, write: (next) => void (lease = next) };
}

type FakeState = {
  page: PageState;
  taps: unknown[];
  ended: number;
  deviceQueries: unknown[];
  reading: RotationReading;
  onStart?: () => void;
};

function fakePage(state: FakeState): SaucePage {
  const session = (device: string): PageState => ({
    url: "https://app.saucelabs.com/live/mobile/x",
    kind: "session",
    device,
    capacityReached: false,
  });
  const requireSession = () => {
    if (state.page.kind !== "session")
      throw new SauceError("no_session", "No live session is open.");
  };
  return {
    state: async () => state.page,
    home: async () => state.page,
    signIn: async () => state.page,
    listApps: async () => [{ id: "f1", label: "Rampage/build.apk" }],
    listDevices: async (query, app) => {
      state.deviceQueries.push({ query, app });
      return { app: app ?? "Rampage/build.apk", devices: [] };
    },
    startSession: async (input) => {
      state.onStart?.();
      if (input.device === "Slow Phone") {
        throw new SauceError("start_pending", "Start Test was clicked; no session page yet.");
      }
      state.page = session(`${input.device} - Android 16`);
      return { app: "Rampage/build.apk", device: state.page.device!, url: state.page.url };
    },
    tap: async (point, rotation) => {
      requireSession();
      state.taps.push({ point, rotation });
    },
    drag: async (from, to, rotation, durationMs, holdMs) => {
      requireSession();
      state.taps.push({ from, to, rotation, durationMs, holdMs });
    },
    clickMenu: async () => requireSession(),
    captureScreen: async (path) => {
      requireSession();
      await writeFile(path, PNG);
      return { width: 2340, height: 1080, reading: state.reading };
    },
    shell: async () => "ok",
    downloadLog: async (path) =>
      writeFile(path, `a\nUnity boom\nb\nUnity payload ${"x".repeat(1000)}`),
    endSession: async () => {
      if (state.page.kind !== "session") return false;
      state.page = { ...state.page, kind: "session_ended" };
      state.ended += 1;
      return true;
    },
  } as SaucePage;
}

function harness() {
  const state: FakeState = {
    page: {
      url: "https://app.saucelabs.com/live/app-testing",
      kind: "live",
      device: null,
      capacityReached: false,
    },
    taps: [],
    ended: 0,
    deviceQueries: [],
    reading: { candidates: [90, 270], best: 90, clear: true },
  };
  let saveGate: Promise<void> = Promise.resolve();
  let now = 1_000_000;
  const saved: string[] = [];
  const store = memoryStore();
  const tools = createSauceTools({
    page: fakePage(state),
    store,
    now: () => now,
    sleep: async () => {},
    tempDir: () => mkdtemp(join(tmpdir(), "ks-sauce-test-")),
    save: async (threadId, name) => {
      await saveGate;
      saved.push(name);
      return `/storage/${threadId}/sauce/${name}`;
    },
    threadTitle: async (threadId) => `title of ${threadId}`,
  });
  return {
    tools,
    state,
    store,
    saved,
    advance: (ms: number) => void (now += ms),
    holdSaves: (gate: Promise<void>) => void (saveGate = gate),
  };
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof SauceError ? error.code : String(error);
  }
}

test("touch points map onto the sideways session canvas", () => {
  // Measured on a Galaxy S23: the cinematic SKIP button sits top-left of the upright game.
  const rect = { left: 726, top: 89, width: 404, height: 878 };
  expect(toViewport({ x: 0.935, y: 0.07 }, 90, rect)).toEqual({ x: 754, y: 146 });
  expect(toViewport({ x: 0, y: 0 }, 0, rect)).toEqual({ x: 726, y: 89 });
  expect(toViewport({ x: 0, y: 0 }, 180, rect)).toEqual({ x: 1130, y: 967 });
  expect(toViewport({ x: 0, y: 0 }, 270, rect)).toEqual({ x: 1130, y: 89 });
});

test("pngSize reads the IHDR dimensions", () => {
  expect(pngSize(PNG)).toEqual({ width: 2340, height: 1080 });
  expect(pngSize(new Uint8Array(4))).toBeNull();
});

test("one thread holds the device; others are refused until it ends", async () => {
  const { tools, state } = harness();
  const a = { threadId: "thr_a" };
  const b = { threadId: "thr_b" };

  await tools.start(a, { device: "Samsung Galaxy S23" });
  expect(await code(tools.start(b, { device: "Pixel 8" }))).toBe("held_by_other_thread");
  expect(await code(tools.catalog(b, { kind: "apps" }))).toBe("held_by_other_thread");
  expect(await code(tools.screenshot(b, {}))).toBe("held_by_other_thread");
  expect(await code(tools.end(b))).toBe("held_by_other_thread");
  const status = (await tools.status(b, {})) as {
    state: string;
    holder: { thread: string; title: string };
  };
  expect(status.state).toBe("held_by_other_thread");
  expect(status.holder).toMatchObject({ thread: "thr_a", title: "title of thr_a" });

  expect(await tools.end(a)).toEqual({ ended: true, released: true });
  expect(state.ended).toBe(1);
  await tools.start(b, { device: "Google Pixel 8" });
  expect(state.page.device).toBe("Google Pixel 8 - Android 16");
});

test("touch needs a screenshot to fix the coordinate frame", async () => {
  const { tools, state, saved } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });

  expect(await code(tools.touch(a, { x: 0.5, y: 0.5 }))).toBe("no_frame");
  const shot = (await tools.screenshot(a, { label: "Title Screen" })) as Record<string, unknown>;
  expect(shot).toMatchObject({ width: 2340, height: 1080, rotation: 90 });
  expect(saved.at(-1)).toEndWith("-title-screen.png");

  await tools.touch(a, { x: 0.18, y: 0.8, to_x: 0.26, to_y: 0.8, hold_ms: 2000 });
  await tools.touch(a, { x: 0.5, y: 0.5 });
  expect(state.taps).toEqual([
    {
      from: { x: 0.18, y: 0.8 },
      to: { x: 0.26, y: 0.8 },
      rotation: 90,
      durationMs: 300,
      holdMs: 2000,
    },
    { point: { x: 0.5, y: 0.5 }, rotation: 90 },
  ]);

  await tools.device(a, { action: "rotate" });
  expect(await code(tools.touch(a, { x: 0.5, y: 0.5 }))).toBe("no_frame");
});

test("an abandoned lease is taken over and its session ended", async () => {
  const { tools, state, advance } = harness();
  await tools.start({ threadId: "thr_a" }, { device: "Samsung Galaxy S23" });
  advance(LEASE_IDLE_MS - 1);
  expect(await code(tools.start({ threadId: "thr_b" }, { device: "Google Pixel 8" }))).toBe(
    "held_by_other_thread",
  );
  advance(1);
  await tools.start({ threadId: "thr_b" }, { device: "Google Pixel 8" });
  expect(state.ended).toBe(1);
  expect(await code(tools.screenshot({ threadId: "thr_a" }, {}))).toBe("held_by_other_thread");
});

test("a session Sauce ended frees the device", async () => {
  const { tools, state, store } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });
  state.page = { ...state.page, kind: "session_ended" };
  expect(await code(tools.screenshot(a, {}))).toBe("no_session");
  expect(store.read()).toBeNull();
});

test("an untracked session is never ended by a thread without the lease", async () => {
  const { tools, state } = harness();
  state.page = {
    url: "https://app.saucelabs.com/live/mobile/x",
    kind: "session",
    device: "iPhone 15 - iOS 18",
    capacityReached: false,
  };
  expect(((await tools.status({ threadId: "thr_a" }, {})) as { state: string }).state).toBe(
    "session_untracked",
  );
  expect(await code(tools.start({ threadId: "thr_a" }, { device: "Google Pixel 8" }))).toBe(
    "session_active",
  );
  expect(await tools.end({ threadId: "thr_a" })).toMatchObject({ ended: false, released: false });
  expect(state.ended).toBe(0);
});

test("the device log is saved and grep returns matching lines", async () => {
  const { tools, saved } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });
  const log = (await tools.device(a, { action: "log", grep: "unity" })) as {
    lines: number;
    matches: string[];
    path: string;
  };
  expect(log.lines).toBe(4);
  expect(log.matches[0]).toBe("Unity boom");
  // Long logcat lines are cut so one payload cannot flood the tool result.
  expect(log.matches[1]).toHaveLength(401);
  expect(log.path).toEndWith("-device.log");
  expect(saved.at(-1)).toEndWith("-device.log");
});

test("a slow save to one thread's host does not hold up other threads", async () => {
  const { tools, holdSaves } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });
  let releaseSave = () => {};
  holdSaves(new Promise<void>((resolve) => (releaseSave = resolve)));
  const shot = tools.screenshot(a, {});
  // Thread B is answered while thread A's screenshot is still being written.
  const status = (await tools.status({ threadId: "thr_b" }, {})) as { state: string };
  expect(status.state).toBe("held_by_other_thread");
  releaseSave();
  expect(await shot).toMatchObject({ rotation: 90 });
});

test("a start that outlasts the wait keeps the lease for the starter", async () => {
  const { tools, store } = harness();
  const a = { threadId: "thr_a" };
  expect(await code(tools.start(a, { device: "Slow Phone" }))).toBe("start_pending");
  expect(store.read()?.threadId).toBe("thr_a");
  expect(await code(tools.start({ threadId: "thr_b" }, { device: "Pixel 8" }))).toBe(
    "held_by_other_thread",
  );
  expect(await tools.end(a)).toEqual({ ended: false, released: true });
  expect(store.read()).toBeNull();
});

test("the device catalog lists devices for the build sauce_start will use", async () => {
  const { tools, state } = harness();
  const listed = (await tools.catalog(
    { threadId: "thr_a" },
    { kind: "devices", query: "Galaxy", app: "rampage-" },
  )) as { app: string };
  expect(listed.app).toBe("rampage-");
  expect(state.deviceQueries).toEqual([{ query: "Galaxy", app: "rampage-" }]);
});

test("sauce tools reach only rampage projects, and every skill stays selected", async () => {
  const { bb, harness: host } = createFakePluginHost({
    pluginId: "kitchen-sink",
    agentSkillIds: SKILLS,
  });
  await plugin(bb);
  expect(host.registrations.agentTools.map((tool) => tool.name)).toEqual([...SAUCE_TOOLS]);

  const rampage = await host.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { name: "rampage-client" } }),
  );
  expect(rampage.tools.map((tool) => tool.name)).toEqual([...SAUCE_TOOLS]);
  expect(rampage.skills).toEqual(SKILLS);

  const other = await host.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ project: { name: "bb-plugins", gitRemoteUrl: null } }),
  );
  expect(other.tools).toEqual([]);
  expect(other.skills).toEqual(SKILLS);
});

test("an unclear rotation never guesses between mirror images", async () => {
  const { tools, state } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });

  // The screen changed during the first landscape capture: no frame, touches refuse.
  state.reading = { candidates: [90, 270], best: 270, clear: false };
  expect(await tools.screenshot(a, {})).toMatchObject({ rotation: null, rotation_measured: false });
  expect(await code(tools.touch(a, { x: 0.5, y: 0.5 }))).toBe("no_frame");

  state.reading = { candidates: [90, 270], best: 90, clear: true };
  expect(await tools.screenshot(a, {})).toMatchObject({ rotation: 90, rotation_measured: true });

  // A later unclear capture keeps the measured rotation instead of flipping it.
  state.reading = { candidates: [90, 270], best: 270, clear: false };
  expect(await tools.screenshot(a, {})).toMatchObject({ rotation: 90, rotation_measured: false });
  expect(await code(tools.touch(a, { x: 0.5, y: 0.5 }))).toBe("ok");

  // A portrait screen in a portrait canvas is upright even when unclear.
  state.reading = { candidates: [0, 180], best: null, clear: false };
  expect(await tools.screenshot(a, {})).toMatchObject({ rotation: 0, rotation_measured: false });
});

function noise(length: number, seed: number) {
  let x = seed;
  return Array.from({ length }, () => ((x = (x * 1103515245 + 12345) % 2 ** 31), x % 256));
}

test("rotation scoring finds the turn and flags a frame that does not match", () => {
  // A portrait canvas (cw 6 x ch 12) showing a landscape screen turned 90 degrees.
  const canvas = { width: 6, height: 12 };
  const frame = noise(72, 7);
  const upright = { width: 12, height: 6 };
  // Turning the canvas 90 degrees clockwise: upright[y][x] = canvas[ch - 1 - x][y].
  const pixels = Array.from({ length: 72 }, (_, i) => {
    const [x, y] = [i % 12, Math.floor(i / 12)];
    return frame[(canvas.height - 1 - x) * canvas.width + y] ?? 0;
  });
  expect(scoreRotation([frame], canvas, { ...upright, pixels }, [90, 270])).toMatchObject({
    candidates: [90, 270],
    best: 90,
    clear: true,
    score: 1,
  });
  // The best of several samples counts: a stale frame next to the right one still reads clear.
  expect(
    scoreRotation([noise(72, 99), frame], canvas, { ...upright, pixels }, [90, 270]).best,
  ).toBe(90);
  // A screen that changed during the capture matches neither turn.
  expect(scoreRotation([noise(72, 3)], canvas, { ...upright, pixels }, [90, 270]).clear).toBe(
    false,
  );
  expect(scoreRotation([null], canvas, { ...upright, pixels }, [90, 270])).toMatchObject({
    best: null,
    clear: false,
  });
});

/** An RGB PNG whose rows use filters None, Sub, Up, and Paeth in turn. */
function encodePng(width: number, height: number, rgb: number[]) {
  const stride = width * 3;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const filter = [0, 1, 2, 4][y % 4] ?? 0;
    raw.push(filter);
    for (let i = 0; i < stride; i += 1) {
      const x = rgb[y * stride + i] ?? 0;
      const a = i >= 3 ? (rgb[y * stride + i - 3] ?? 0) : 0;
      const b = y > 0 ? (rgb[(y - 1) * stride + i] ?? 0) : 0;
      const c = y > 0 && i >= 3 ? (rgb[(y - 1) * stride + i - 3] ?? 0) : 0;
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 4 ? paeth(a, b, c) : 0;
      raw.push((x - predicted + 256) % 256);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
      [...type].map((ch) => ch.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    return out; // pngGrayThumbnail does not check CRCs
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

test("the PNG decoder reverses every row filter and box-averages to gray", async () => {
  const [width, height] = [4, 4];
  const rgb = noise(width * height * 3, 5);
  const gray = await pngGrayThumbnail(encodePng(width, height, rgb), 2, 2);
  const at = (x: number, y: number) => {
    const p = (y * width + x) * 3;
    return 0.299 * (rgb[p] ?? 0) + 0.587 * (rgb[p + 1] ?? 0) + 0.114 * (rgb[p + 2] ?? 0);
  };
  const cell = (cx: number, cy: number) =>
    Math.round(
      (at(cx * 2, cy * 2) +
        at(cx * 2 + 1, cy * 2) +
        at(cx * 2, cy * 2 + 1) +
        at(cx * 2 + 1, cy * 2 + 1)) /
        4,
    );
  expect([...(gray ?? [])]).toEqual([cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)]);
});

test("a call cancelled while queued never runs, and a cancelled start hands the device back", async () => {
  const { tools, state, store } = harness();
  const stopped = new AbortController();
  stopped.abort();
  expect(
    await code(tools.start({ threadId: "thr_a", signal: stopped.signal }, { device: "Pixel 8" })),
  ).toBe("cancelled");
  expect(store.read()).toBeNull();

  // The thread is stopped while its device comes up.
  const midway = new AbortController();
  state.onStart = () => midway.abort();
  expect(
    await code(tools.start({ threadId: "thr_a", signal: midway.signal }, { device: "Pixel 8" })),
  ).toBe("cancelled");
  expect(state.ended).toBe(1);
  expect(store.read()).toBeNull();
});

test("a lease whose session is gone frees the device for other threads", async () => {
  const { tools, state, store } = harness();
  await tools.start({ threadId: "thr_a" }, { device: "Samsung Galaxy S23" });
  // Sauce ends thr_a's idle session; thr_a never calls another device tool.
  state.page = { ...state.page, kind: "session_ended" };
  const status = (await tools.status({ threadId: "thr_b" }, {})) as { state: string };
  expect(status.state).not.toBe("held_by_other_thread");
  expect(store.read()).toBeNull();
  await tools.start({ threadId: "thr_b" }, { device: "Google Pixel 8" });
  expect(store.read()?.threadId).toBe("thr_b");
});

test("the holder's own status and end clear a lease whose session ended", async () => {
  const { tools, state, store } = harness();
  const a = { threadId: "thr_a" };
  await tools.start(a, { device: "Samsung Galaxy S23" });
  state.page = { ...state.page, kind: "session_ended" };
  expect(await tools.end(a)).toEqual({ ended: false, released: true });

  await tools.start(a, { device: "Samsung Galaxy S23" });
  state.page = { ...state.page, kind: "session_ended" };
  expect(await tools.status(a, {})).toMatchObject({ lease: null });
  expect(store.read()).toBeNull();
});

test("a start still coming up keeps its lease even before the session page shows", async () => {
  const { tools, state, store, advance } = harness();
  expect(await code(tools.start({ threadId: "thr_a" }, { device: "Slow Phone" }))).toBe(
    "start_pending",
  );
  state.page = { ...state.page, kind: "live" };
  expect(await code(tools.start({ threadId: "thr_b" }, { device: "Pixel 8" }))).toBe(
    "held_by_other_thread",
  );
  // After the grace period a start that never produced a session is stale.
  advance(3 * 60 * 1000);
  await tools.start({ threadId: "thr_b" }, { device: "Google Pixel 8" });
  expect(store.read()?.threadId).toBe("thr_b");
});

test("picker and search actions that hit a re-rendering element retry instead of failing", async () => {
  const calls: string[] = [];
  let pickerOpen = false;
  const misses = { click: 1, fill: 1 };
  const miss = () => Promise.reject(new Error("Element not found: the element is being replaced"));
  let now = 0;
  const page = createSaucePage(
    {
      async run(args) {
        const [command, target] = args;
        calls.push(`${command} ${target ?? ""}`.trim());
        if (command === "click" && target === "[data-qa=search-dialog-input-trigger]") {
          if (misses.click-- > 0) return miss();
          pickerOpen = true;
          return {};
        }
        if (command === "fill" && target === "[data-qa=device-filter-bar-search]") {
          return misses.fill-- > 0 ? miss() : {};
        }
        if (command === "find" && args.includes("Dismiss")) pickerOpen = false;
        if (command !== "eval") return {};
        const script = target ?? "";
        const result = script.includes("location.host")
          ? {
              url: "https://app.saucelabs.com/live/app-testing",
              host: "app.saucelabs.com",
              path: "/live/app-testing",
              ended: false,
              device: null,
              capacity: false,
            }
          : script.includes("[data-qa=search-dialog]")
            ? pickerOpen
            : script.includes("app-search-and-select-file-id-")
              ? [{ id: "f1", label: "Rampage/Rampage-se-dev.apk" }]
              : script.includes("[data-qa=device-table]")
                ? [
                    {
                      name: "Samsung Galaxy S23",
                      status: "Available",
                      os: "Android 16",
                      screen: "6.1",
                    },
                  ]
                : true;
        return { result };
      },
    },
    { sleep: async (ms) => void (now += ms), now: () => now, grayThumbnail: async () => null },
  );

  const listed = await page.listDevices("Galaxy S23", "rampage-");
  expect(listed.devices.map((d) => d.name)).toEqual(["Samsung Galaxy S23"]);
  expect(calls.filter((c) => c === "click [data-qa=search-dialog-input-trigger]")).toHaveLength(2);
  expect(calls.filter((c) => c === "fill [data-qa=device-filter-bar-search]")).toHaveLength(2);
});
