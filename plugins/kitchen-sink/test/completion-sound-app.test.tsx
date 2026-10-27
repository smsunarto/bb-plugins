import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { WORKSPACE_CHANGED_CHANNEL } = await import("../src/shared/contract.ts");

const SOUND_PATH = "/api/v1/plugins/kitchen-sink/http/completion-sound";

/** Every audible `<audio>.play()` the page attempted, by the path it played. */
let played: string[] = [];
let playOutcome: () => Promise<void> = async () => {};
/** Every chime note the page synthesized, in hertz. */
let chimed: number[] = [];
/** Every `<audio>.pause()`, by the path it paused. */
let paused: string[] = [];
/** Every AudioContext the page created. */
let contexts: FakeAudioContext[] = [];
const originalPlay = HTMLMediaElement.prototype.play;
const originalPause = HTMLMediaElement.prototype.pause;

/**
 * The autoplay rule the fakes enforce. "webkit" is Safari's per-element rule:
 * an audio element or AudioContext sounds only after a gesture started it.
 */
let policy: "permissive" | "webkit" = "permissive";
let inGesture = false;
let startedInGesture = new WeakSet<object>();

/** Dispatch a user gesture, which WebKit honours only while it runs. */
function gesture(fire: () => void) {
  inGesture = true;
  try {
    fire();
  } finally {
    inGesture = false;
  }
}

function mayStart(media: object): boolean {
  if (inGesture) startedInGesture.add(media);
  return policy === "permissive" || startedInGesture.has(media);
}

class FakeAudioContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  destination = {};
  constructor() {
    contexts.push(this);
  }
  resume() {
    // WebKit leaves resume() pending until a gesture has started the context.
    if (!mayStart(this)) return new Promise<void>(() => {});
    this.state = "running";
    return Promise.resolve();
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.state = "closed";
  }
  createGain() {
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    return { gain: param, connect: (next: unknown) => next };
  }
  createOscillator() {
    const tone = {
      frequency: { value: 0 },
      connect: (next: unknown) => next,
      start: () => chimed.push(tone.frequency.value),
      stop() {},
    };
    return tone;
  }
}

/** One browser's Web Locks: an exclusive lock that the next waiting tab gets on release. */
function installBrowserLocks() {
  let held = false;
  const waiting: Array<() => void> = [];
  const locks = {
    request(
      _name: string,
      options: { signal?: AbortSignal },
      callback: (lock: unknown) => Promise<void>,
    ) {
      return new Promise<void>((resolve, reject) => {
        const grant = () => {
          held = true;
          void callback({})
            .then(resolve, reject)
            .finally(() => {
              held = false;
              waiting.shift()?.();
            });
        };
        if (!held) return grant();
        waiting.push(grant);
        options.signal?.addEventListener("abort", () => {
          waiting.splice(waiting.indexOf(grant), 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
}

beforeEach(() => {
  played = [];
  chimed = [];
  paused = [];
  contexts = [];
  policy = "permissive";
  startedInGesture = new WeakSet();
  playOutcome = async () => {};
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    const permitted = mayStart(this);
    // WebKit lets a muted element play without a gesture, but only a gesture unlocks it.
    if (this.muted) return Promise.resolve();
    if (!permitted) return Promise.reject(new DOMException("gesture required", "NotAllowedError"));
    played.push(new URL(this.src).pathname);
    return playOutcome();
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    paused.push(new URL(this.src).pathname);
  };
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (navigator as { locks?: unknown }).locks;
  delete (navigator as { userActivation?: unknown }).userActivation;
});

async function openTab() {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const overlay = captured.appOverlays.find(({ id }) => id === "completion-sound");
  if (!overlay) throw new Error("completion-sound overlay is not registered");
  return renderSlot(overlay, {}, { pluginId: "kitchen-sink" });
}

const idle = { threadId: "thr_done", parentThreadId: null, reason: "idle" };

test("an idle thread plays Cursor's sound from the plugin route, and nothing else does", async () => {
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { ...idle, reason: "failed" });
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { ...idle, reason: "archived" });
  expect(played).toEqual([]);

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH, SOUND_PATH]);
  expect(chimed).toEqual([]);
  tab.unmount();
});

test("subthread completion stays silent, including the synthesized fallback", async () => {
  playOutcome = () => Promise.reject(new DOMException("no source", "NotSupportedError"));
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, {
    ...idle,
    parentThreadId: "thr_parent",
  });
  expect(played).toEqual([]);
  expect(chimed).toEqual([]);

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));
  tab.unmount();
});

test("several tabs in one browser play once, and another tab takes over when the player closes", async () => {
  installBrowserLocks();
  const first = await openTab();
  const second = await openTab();
  await first.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await second.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH]);

  first.unmount();
  await waitFor(async () => {
    await second.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
    expect(played).toEqual([SOUND_PATH, SOUND_PATH]);
  });
  second.unmount();
});

test("a tab the user has not touched stays out of the election until they interact", async () => {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive: false },
  });
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([]);

  fireEvent.click(window);
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH]);
  tab.unmount();
});

test("in WebKit, the first click unlocks one audio element that every later completion reuses", async () => {
  policy = "webkit";
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive: false },
  });
  const tab = await openTab();
  gesture(() => fireEvent.click(window));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH, SOUND_PATH]);
  tab.unmount();
});

test("in WebKit, a refused completion plays again after the next gesture", async () => {
  policy = "webkit";
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([]);

  gesture(() => fireEvent.keyDown(window, { key: "Enter" }));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH]);

  // The browser takes its permission back, as when the site's Auto-Play setting changes.
  startedInGesture = new WeakSet();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH]);
  gesture(() => fireEvent.click(window));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  expect(played).toEqual([SOUND_PATH, SOUND_PATH]);
  tab.unmount();
});

test("a click while the sound plays leaves it playing", async () => {
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  gesture(() => fireEvent.click(window));
  expect(played).toEqual([SOUND_PATH]);
  expect(paused).toEqual([]);
  tab.unmount();
});

test("a click during a chime leaves it sounding", async () => {
  playOutcome = () => Promise.reject(new DOMException("no source", "NotSupportedError"));
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));
  gesture(() => fireEvent.click(window));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(contexts.map(({ state }) => state)).toEqual(["running"]);
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]), {
    timeout: 3_000,
  });
  tab.unmount();
});

test("in WebKit, the chime reuses one context the click started, idle between chimes", async () => {
  policy = "webkit";
  playOutcome = () => Promise.reject(new DOMException("no source", "NotSupportedError"));
  const tab = await openTab();
  gesture(() => fireEvent.click(window));
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]));

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5, 880, 1318.5]));
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]), {
    timeout: 3_000,
  });

  tab.unmount();
  expect(contexts.map(({ state }) => state)).toEqual(["closed"]);
});

test("without a Cursor install anywhere, the browser synthesizes a chime instead", async () => {
  playOutcome = () => Promise.reject(new DOMException("no source", "NotSupportedError"));
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5, 880, 1318.5]));
  expect(played).toEqual([SOUND_PATH]);
  tab.unmount();
});

test("a browser that blocks autoplay stays silent instead of chiming", async () => {
  playOutcome = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(played).toEqual([SOUND_PATH, SOUND_PATH]);
  expect(chimed).toEqual([]);
  tab.unmount();
});
