import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  toViewport,
  type PageState,
  type SaucePage,
} from "../src/server/lib/sauce/live.ts";
import { SAUCE_TOOLS, createSauceTools, pngSize } from "../src/server/lib/sauce/tools.ts";

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

type FakeState = { page: PageState; taps: unknown[]; ended: number; deviceQueries: unknown[] };

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
    nativeScreenshot: async (path) => {
      requireSession();
      await writeFile(path, PNG);
    },
    measureRotation: async () => 90,
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
