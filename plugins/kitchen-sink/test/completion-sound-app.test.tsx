import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { WORKSPACE_CHANGED_CHANNEL } = await import("../src/shared/contract.ts");

const SOUND_PATH = "/api/v1/plugins/kitchen-sink/http/completion-sound";

/** Every time the page sounded Cursor's decoded sound. */
let played: string[] = [];
/** Every chime note the page synthesized, in hertz. */
let chimed: number[] = [];
/** Every request for the sound route. */
let fetched: string[] = [];
/** What the sound route answers. */
let route: () => Promise<Response> = async () => new Response(new Uint8Array([1, 2, 3]));
/** Every `<audio>`/`<video>` play, which iOS would list in Now Playing. */
let mediaPlays = 0;
/** Every AudioContext the page created. */
let contexts: FakeAudioContext[] = [];
const originalPlay = HTMLMediaElement.prototype.play;
const originalFetch = globalThis.fetch;

/**
 * The autoplay rule the fakes enforce. "webkit" is Safari's rule: an
 * AudioContext sounds only after a gesture resumed it.
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
  async decodeAudioData(_data: ArrayBuffer) {
    return { duration: 0.01 };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: (next: unknown) => next,
      start: () => played.push(SOUND_PATH),
    };
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
  fetched = [];
  mediaPlays = 0;
  contexts = [];
  policy = "permissive";
  startedInGesture = new WeakSet();
  route = async () => new Response(new Uint8Array([1, 2, 3]));
  HTMLMediaElement.prototype.play = function () {
    mediaPlays += 1;
    return Promise.resolve();
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return route();
  }) as typeof fetch;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});

afterEach(() => {
  expect(mediaPlays).toBe(0);
  HTMLMediaElement.prototype.play = originalPlay;
  globalThis.fetch = originalFetch;
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
const noSound = async () => new Response(null, { status: 404 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("an idle thread plays Cursor's sound through Web Audio, and nothing else does", async () => {
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { ...idle, reason: "failed" });
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, { ...idle, reason: "archived" });
  await settle();
  expect(played).toEqual([]);

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH, SOUND_PATH]));
  expect(fetched).toEqual([SOUND_PATH]);
  expect(chimed).toEqual([]);
  tab.unmount();
});

test("subthread completion stays silent, including the synthesized fallback", async () => {
  route = noSound;
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, {
    ...idle,
    parentThreadId: "thr_parent",
  });
  await settle();
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
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  await settle();
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
  await settle();
  expect(played).toEqual([]);

  fireEvent.click(window);
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  tab.unmount();
});

test("in WebKit, the first click starts one context that every later completion reuses, idle between sounds", async () => {
  policy = "webkit";
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { hasBeenActive: false },
  });
  const tab = await openTab();
  gesture(() => fireEvent.click(window));
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]));

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH, SOUND_PATH]));
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]));

  tab.unmount();
  expect(contexts.map(({ state }) => state)).toEqual(["closed"]);
});

test("in WebKit, a refused completion stays silent and plays again after the next gesture", async () => {
  policy = "webkit";
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(played).toEqual([]);
  expect(chimed).toEqual([]);

  gesture(() => fireEvent.keyDown(window, { key: "Enter" }));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  tab.unmount();
});

test("a click during a sound leaves it sounding", async () => {
  route = noSound;
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));
  gesture(() => fireEvent.click(window));
  await settle();
  expect(contexts.map(({ state }) => state)).toEqual(["running"]);
  await waitFor(() => expect(contexts.map(({ state }) => state)).toEqual(["suspended"]), {
    timeout: 3_000,
  });
  tab.unmount();
});

test("without a Cursor install anywhere, the browser synthesizes a chime instead", async () => {
  route = noSound;
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));

  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5, 880, 1318.5]));
  expect(played).toEqual([]);
  expect(fetched).toEqual([SOUND_PATH]);
  tab.unmount();
});

test("a failed fetch chimes and fetches again on the next completion", async () => {
  route = () => Promise.reject(new TypeError("offline"));
  const tab = await openTab();
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(chimed).toEqual([880, 1318.5]));

  route = async () => new Response(new Uint8Array([1]));
  await tab.behavior.emitRealtime(WORKSPACE_CHANGED_CHANNEL, idle);
  await waitFor(() => expect(played).toEqual([SOUND_PATH]));
  expect(fetched).toEqual([SOUND_PATH, SOUND_PATH]);
  tab.unmount();
});
