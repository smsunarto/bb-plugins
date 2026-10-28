// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PluginSettingsState } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The plugin's settings as BB serves them: a store its subscribers re-render from, like BB's query. */
const settings = vi.hoisted(() => {
  let state: PluginSettingsState = { values: undefined, isLoading: true };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: PluginSettingsState) {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useSettings: () => useSyncExternalStore(settings.subscribe, settings.get),
}));

const LOADING: PluginSettingsState = { values: undefined, isLoading: true };
const ON: PluginSettingsState = { values: { animations: true, webLookups: true }, isLoading: false };
const OFF: PluginSettingsState = { values: { animations: false, webLookups: true }, isLoading: false };

type Motion = typeof import("./motion");

/** motion.ts as a fresh page loads it: the system's setting and localStorage are read at load. */
async function load(systemReduced = false): Promise<Motion> {
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: systemReduced, addEventListener() {}, removeEventListener() {} }));
  vi.resetModules();
  return import("./motion");
}

// jsdom has no Web Animations; an entrance that plays is recorded here.
const animate = vi.fn(() => ({ cancel() {} }));
let container: HTMLDivElement;
let root: Root;

/** A block's root and one element that enters; a new `key` mounts it again. */
function mount(motion: Motion, key: string): HTMLElement {
  function Entering() {
    const ref = motion.useEntrance<HTMLParagraphElement>(motion.FADE);
    return <p ref={ref}>Hello</p>;
  }
  function Block() {
    return (
      <div data-testid="block" {...motion.useMotionScope()}>
        <Entering />
      </div>
    );
  }
  act(() => root.render(<Block key={key} />));
  return container.querySelector<HTMLElement>('[data-testid="block"]')!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { supports: () => false });
  animate.mockClear();
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  localStorage.clear();
  settings.set(LOADING);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
});

describe("the Animations setting", () => {
  it("plays entrances while it is on, and holds still from the moment it is turned off", async () => {
    const motion = await load();
    settings.set(ON);
    const block = mount(motion, "first");
    expect(animate).toHaveBeenCalledTimes(1);
    expect(block.hasAttribute("data-genui-motion")).toBe(false);
    expect(motion.reducedMotion()).toBe(false);

    act(() => settings.set(OFF));
    expect(block.getAttribute("data-genui-motion")).toBe("off");
    expect(motion.reducedMotion()).toBe(true);
    mount(motion, "second");
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("stays off on the next page until BB answers, then follows the answer", async () => {
    settings.set(OFF);
    mount(await load(), "first");
    act(() => root.unmount());
    root = createRoot(container);

    settings.set(LOADING);
    const motion = await load();
    expect(motion.reducedMotion()).toBe(true);
    const block = mount(motion, "next page");
    expect(block.getAttribute("data-genui-motion")).toBe("off");
    expect(animate).not.toHaveBeenCalled();

    act(() => settings.set(ON));
    expect(block.hasAttribute("data-genui-motion")).toBe(false);
    expect(motion.reducedMotion()).toBe(false);
    expect((await load()).reducedMotion()).toBe(false);
  });

  it("stops a 3D frame loop that is already playing, and starts it again", async () => {
    let handles = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.set(++handles, callback);
      return handles;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => pending.delete(handle));
    const step = () => {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(performance.now());
    };
    settings.set(ON);
    await load();
    const { useFrameLoop } = await import("./gpu");
    const frame = vi.fn();
    function Loop() {
      useFrameLoop(true, frame);
      return null;
    }
    act(() => root.render(<Loop />));
    step();
    step();
    expect(frame).toHaveBeenCalledTimes(2);

    act(() => settings.set(OFF));
    // One still frame, then nothing more is scheduled.
    expect(frame).toHaveBeenCalledTimes(3);
    expect(frame).toHaveBeenLastCalledWith(0, 0);
    step();
    expect(frame).toHaveBeenCalledTimes(3);

    act(() => settings.set(ON));
    step();
    expect(frame).toHaveBeenCalledTimes(4);
  });

  it("leaves the system's reduced-motion setting in charge while it is on", async () => {
    const motion = await load(true);
    settings.set(ON);
    const block = mount(motion, "first");
    expect(motion.reducedMotion()).toBe(true);
    expect(animate).not.toHaveBeenCalled();
    // CSS follows the system through motion-reduce: variants; the mark is only for the setting.
    expect(block.hasAttribute("data-genui-motion")).toBe(false);
  });
});
