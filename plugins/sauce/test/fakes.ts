import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSauceCore, type SauceCoreDeps } from "../src/server/core.ts";
import { NO_DEFAULTS, type DefaultsStore, type ProjectDefaults } from "../src/server/defaults.ts";
import type { LeaseStore, SauceLease } from "../src/server/lease.ts";
import {
  SauceError,
  type Orientation,
  type PageState,
  type SaucePage,
} from "../src/server/live.ts";

export const SESSION_URL = "https://app.saucelabs.com/live/mobile/x";

export function memoryStore(): LeaseStore {
  let lease: SauceLease | null = null;
  return { read: () => lease, write: (next) => void (lease = next) };
}

export function memoryDefaults(): DefaultsStore {
  const rows = new Map<string, ProjectDefaults>();
  return {
    read: (projectId) => rows.get(projectId) ?? NO_DEFAULTS,
    write: (projectId, defaults) => void rows.set(projectId, defaults),
  };
}

/** The projects the fake bb knows, by id. */
export const PROJECTS: Record<string, string> = { proj_game: "rampage", proj_app: "bb" };

/** A flat grayscale sample; two screens with different `gray` read as changed. */
export function screen(gray: number): Uint8Array {
  return new Uint8Array(48 * 22).fill(gray);
}

/**
 * A stand-in for the Sauce Live tab at the level the core drives it: what the device
 * shows (`gray`), what reached it (`sent`), and a clock that only waiting advances.
 */
export function fakeDevice() {
  const world = {
    page: {
      url: "https://app.saucelabs.com/live/app-testing",
      kind: "live",
      device: null,
      capacityReached: false,
    } as PageState,
    /** The device screen as one gray level; `onSample` may change it between polls. */
    gray: 10,
    sent: [] as string[],
    samples: 0,
    captures: 0,
    glances: 0,
    /** The Device Log panel's tail; `onTail` may append to it between reads. */
    log: ["12:00:01 I Unity : boot"] as string[],
    tails: 0,
    onTail: (_count: number): void => {},
    /** What the next full look reads the rotation as. */
    reading: { candidates: [90, 270] as const, best: 90 as number | null, clear: true },
    now: 1_000_000,
    saved: [] as string[],
    onSample: (_count: number): void => {},
    onGesture: (_text: string): void => {},
    failCapture: null as SauceError | null,
    /** How the device is held; a session starts portrait. */
    orientation: "portrait" as Orientation,
    failOrient: null as SauceError | null,
  };
  const requireSession = () => {
    if (world.page.kind !== "session")
      throw new SauceError("no_session", "No live session is open.");
    return world.page;
  };
  const page = {
    state: async () => world.page,
    home: async () => world.page,
    signIn: async () => world.page,
    listApps: async () => [{ id: "f1", label: "Rampage/build.apk" }],
    uploadApp: async (path: string, name: string) => {
      world.sent.push(`upload ${path}`);
      return { id: "f2", label: `Uploads/${name} v1 • Build 1` };
    },
    listDevices: async (_query: string, app?: string) => ({
      app: app ?? "Rampage/build.apk",
      devices: [
        { name: "Samsung Galaxy S23", status: "Available", os: "Android 16", screen: "6.1" },
      ],
      truncated: false,
    }),
    startSession: async (input: { device: string }) => {
      world.page = {
        url: SESSION_URL,
        kind: "session",
        device: `${input.device} - Android 16`,
        capacityReached: false,
      };
      world.orientation = "portrait";
      return { app: "Rampage/build.apk", device: world.page.device as string, url: SESSION_URL };
    },
    orient: async (target: Orientation) => {
      requireSession();
      if (world.failOrient) throw world.failOrient;
      const turned = world.orientation !== target;
      if (turned) world.sent.push(`orient ${target}`);
      world.orientation = target;
      return { turned };
    },
    tap: async (point: { x: number; y: number }, _rotation: number, holdMs = 0) => {
      requireSession();
      const text = `tap ${point.x} ${point.y}${holdMs ? ` hold ${holdMs}` : ""}`;
      world.sent.push(text);
      world.onGesture(text);
    },
    drag: async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      _rotation: number,
      durationMs: number,
      holdMs: number,
    ) => {
      requireSession();
      const text = `drag ${from.x} ${from.y} ${to.x} ${to.y} ${durationMs} ${holdMs}`;
      world.sent.push(text);
      world.onGesture(text);
    },
    clickMenu: async (name: string) => {
      requireSession();
      world.sent.push(`menu ${name}`);
    },
    captureScreen: async (path: string) => {
      requireSession();
      if (world.failCapture) throw world.failCapture;
      world.captures += 1;
      const bytes = new Uint8Array(32);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, 2340);
      view.setUint32(20, 1080);
      await writeFile(path, bytes);
      return {
        width: 2340,
        height: 1080,
        reading: world.reading,
        thumbnail: screen(world.gray),
      };
    },
    glanceScreen: async (path: string, rotation: number) => {
      requireSession();
      world.glances += 1;
      world.sent.push(`glance ${rotation}`);
      await writeFile(path, new Uint8Array(8));
      // The page's video is a little lighter than the device's own pixels.
      return { width: 900, height: 415, thumbnail: screen(world.gray + 3) };
    },
    typeText: async (text: string) => {
      requireSession();
      world.sent.push(`type ${text}`);
      world.onGesture(`type ${text}`);
    },
    pressKey: async (key: string) => {
      requireSession();
      world.sent.push(`key ${key}`);
      world.onGesture(`key ${key}`);
    },
    sampleScreen: async () => {
      if (world.page.kind !== "session") return null;
      world.samples += 1;
      world.onSample(world.samples);
      return screen(world.gray);
    },
    requireSession: async () => requireSession(),
    shell: async (command: string) => {
      requireSession();
      world.sent.push(`shell ${command}`);
      return "ok";
    },
    logTail: async () => {
      requireSession();
      world.tails += 1;
      world.onTail(world.tails);
      return [...world.log];
    },
    downloadLog: async (path: string) => writeFile(path, "a\nUnity boom\nb"),
    endSession: async () => {
      if (world.page.kind !== "session") return false;
      world.page = { ...world.page, kind: "session_ended" };
      return true;
    },
    abortStart: async () => true,
  } as unknown as SaucePage;
  const deps: SauceCoreDeps = {
    page,
    store: memoryStore(),
    defaults: memoryDefaults(),
    projectName: async (projectId) => PROJECTS[projectId] ?? null,
    now: () => world.now,
    sleep: async (ms) => void (world.now += ms),
    tempDir: () => mkdtemp(join(tmpdir(), "bb-sauce-fake-")),
    save: async (threadId, name) => {
      world.saved.push(name);
      return `/storage/${threadId}/sauce/${name}`;
    },
    threadTitle: async (threadId) => `title of ${threadId}`,
    fileSize: async (path) => (path.startsWith("/builds/") ? 72_183_687 : null),
  };
  return { world, deps, core: createSauceCore(deps) };
}

export async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof SauceError ? error.code : String(error);
  }
}
