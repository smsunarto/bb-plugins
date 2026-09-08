import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountTimelineMotion } from "./timeline-motion.ts";
import { isThreadWorking, PROBE_ATTRIBUTE, PROBE_WORKING_ATTRIBUTE } from "./thread-activity.ts";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

let dom: JSDOM;
let document: Document;
let view: Window & typeof globalThis;
let dispose: () => void;
let original: PropertyDescriptor;
let frames: Map<number, FrameRequestCallback>;
let time: number;
let nextFrame: number;
let reduced: MediaQueryList;
let globals: Map<string, PropertyDescriptor | undefined>;

function tick(count = 1): void {
  for (let i = 0; i < count; i++) {
    time += 1000 / 60;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  }
}

function timeline(start = 0, max = 1000, scoped = true) {
  const root = document.createElement("div");
  if (scoped) root.dataset.threadWindow = "test";
  root.innerHTML =
    '<div class="thread-scrollbar"><div><div>Rows</div><div class="scroll-bottom-anchor"></div></div></div>';
  const element = root.firstElementChild as HTMLElement;
  const geometry = { max, top: start };
  Object.defineProperties(element, {
    scrollHeight: { get: () => geometry.max + 200 },
    clientHeight: { get: () => 200 },
    clientWidth: { get: () => 300 },
    scrollTo: {
      value: mock((options: ScrollToOptions) => {
        geometry.top = Math.max(0, Math.min(options.top ?? geometry.top, geometry.max));
      }),
    },
  });
  physical.set(element, geometry);
  document.body.append(root);
  return { root, element, geometry };
}

const physical = new WeakMap<Element, { top: number; max: number }>();

/** The marker the plugin's thread-header slot renders inside a thread's pane. */
function probe(container: Element, working: boolean, threadId = "thr_test"): HTMLElement {
  const marker = document.createElement("span");
  marker.setAttribute(PROBE_ATTRIBUTE, threadId);
  marker.setAttribute(PROBE_WORKING_ATTRIBUTE, working ? "true" : "false");
  container.append(marker);
  return marker;
}

function sidebarThread(overrides: Partial<PluginSidebarThread>): PluginSidebarThread {
  return {
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    ...overrides,
  } as PluginSidebarThread;
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true,
  });
  document = dom.window.document;
  view = dom.window as unknown as Window & typeof globalThis;
  time = 100;
  nextFrame = 1;
  frames = new Map();
  view.requestAnimationFrame = mock((callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  view.cancelAnimationFrame = mock((id: number) => {
    frames.delete(id);
  });
  const query = new view.EventTarget();
  reduced = Object.assign(query, {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  }) as MediaQueryList;
  view.matchMedia = mock(() => reduced);
  Object.defineProperty(view.performance, "now", { value: () => time });
  globals = new Map();
  for (const [key, value] of Object.entries({
    window: view,
    Window: view.Window,
    document,
    navigator: view.navigator,
    HTMLElement: view.HTMLElement,
    CustomEvent: view.CustomEvent,
    requestAnimationFrame: view.requestAnimationFrame,
    cancelAnimationFrame: view.cancelAnimationFrame,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const native = Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")!;
  Object.defineProperty(view.Element.prototype, "scrollTop", {
    ...native,
    get(this: Element) {
      return physical.get(this)?.top ?? native.get!.call(this);
    },
    set(this: Element, value: number) {
      const geometry = physical.get(this);
      if (geometry) geometry.top = Math.max(0, Math.min(value, geometry.max));
      else native.set!.call(this, value);
    },
  });
  original = Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")!;
  dispose = () => {};
});

afterEach(() => {
  dispose();
  dom.window.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("Kitchen Sink mounts timeline motion and restores native scrolling on unload", async () => {
  const { loadPluginApp, mountPluginContentScripts } =
    await import("@get-bb/plugin-sdk/testing/app");
  const app = await loadPluginApp(() => import("../app.tsx"));
  const mounted = await mountPluginContentScripts(app, { pluginId: "kitchen-sink" });
  try {
    const { element, geometry } = timeline();
    element.scrollTop = 1000;
    expect(geometry.top).toBe(1000);
    tick(20);
    element.scrollTop = 300;
    tick();
    expect(geometry.top).toBeGreaterThan(300);
    expect(geometry.top).toBeLessThan(1000);
    expect(document.querySelector("[data-kitchen-sink-thread-scroll]")).not.toBeNull();
  } finally {
    await mounted.lifecycle.dispose();
  }
  expect(Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")).toEqual(original);
  expect(document.querySelector("[data-kitchen-sink-thread-scroll]")).toBeNull();
});

describe("initial timeline placement with real Lenis", () => {
  test("places a remounted bottom timeline immediately and keeps repeated requests still", () => {
    dispose = mountTimelineMotion(document);
    const previous = timeline(3472, 3472);
    previous.element.scrollTop = 3472;
    previous.root.remove();
    const { element } = timeline(0, 3472);
    element.scrollTop = 3472;
    expect(element.scrollTop).toBe(3472);
    for (let i = 0; i < 10; i++) {
      element.scrollTop = 3472;
      tick();
      expect(element.scrollTop).toBe(3472);
    }
    expect(frames.size).toBe(0);
  });

  test("animates later bottom growth after immediate initial placement", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(1000);
    tick(20);
    geometry.max = 1200;
    element.scrollTop = 1200;
    expect(element.scrollTop).toBe(1000);
    tick();
    expect(element.scrollTop).toBeGreaterThan(1000);
    expect(element.scrollTop).toBeLessThan(1200);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1200, 0);
  });

  test("settles mobile mount layout corrections without replaying bottom scrolling", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline(0, 5329);
    element.scrollTop = 5329;
    tick();
    geometry.max = 5401;
    element.scrollTop = 5401;
    expect(element.scrollTop).toBe(5401);
    tick(5);
    geometry.max = 5402;
    element.scrollTop = 5402;
    expect(element.scrollTop).toBe(5402);
    expect(frames.size).toBe(0);
    tick(10);
    geometry.max = 5502;
    element.scrollTop = 5502;
    expect(element.scrollTop).toBe(5402);
    tick();
    expect(element.scrollTop).toBeGreaterThan(5402);
    expect(element.scrollTop).toBeLessThan(5502);
  });

  test("empty layout writes do not consume the first scrollable bottom placement", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline(0, 0);
    element.scrollTop = 0;
    tick(100);
    geometry.max = 5329;
    element.scrollTop = 5329;
    expect(element.scrollTop).toBe(5329);
    tick();
    geometry.max = 5401;
    element.scrollTop = 5401;
    expect(element.scrollTop).toBe(5401);
    expect(frames.size).toBe(0);
  });

  test("an explicit offset ends bottom placement settling", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 1000;
    element.scrollTop = 800;
    tick(3);
    const current = element.scrollTop;
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(current);
    tick();
    expect(element.scrollTop).toBeGreaterThan(current);
    expect(element.scrollTop).toBeLessThan(1000);
  });

  test("touch input interrupts initial bottom settling", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 1000;
    element.dispatchEvent(new view.Event("touchstart", { bubbles: true }));
    geometry.top = 700;
    element.scrollTop = 1000;
    tick(5);
    expect(element.scrollTop).toBe(700);
    expect(frames.size).toBe(0);
    element.dispatchEvent(new view.Event("touchend", { bubbles: true }));
    tick(20);
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(700);
    tick();
    expect(element.scrollTop).toBeGreaterThan(700);
    expect(element.scrollTop).toBeLessThan(1000);
  });

  test("manual input before the first bottom write retains control", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline(700);
    element.dispatchEvent(new view.WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    geometry.top = 600;
    element.scrollTop = 1000;
    tick(10);
    expect(element.scrollTop).toBe(600);
    expect(frames.size).toBe(0);
    tick(10);
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(600);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1000, 0);
  });
});

describe("settled timeline writes with real Lenis", () => {
  for (const reduceMotion of [false, true]) {
    test(`settled writes avoid class mutations${reduceMotion ? " with reduced motion" : ""}`, () => {
      Object.assign(reduced, { matches: reduceMotion });
      dispose = mountTimelineMotion(document);
      const { element } = timeline();
      element.scrollTop = 1000;
      const observer = new view.MutationObserver(() => {});
      observer.observe(element, { attributes: true, attributeFilter: ["class"] });
      for (let i = 0; i < 300; i++) element.scrollTop = 1000;
      const mutations = observer.takeRecords();
      observer.disconnect();
      expect(mutations).toHaveLength(0);
      expect(element.scrollTop).toBe(1000);
      expect(frames.size).toBe(0);
    });
  }

  test("a new animation starts from physical native scroll before its event arrives", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 1000;
    geometry.top = 600;
    element.scrollTop = 300;
    expect(element.scrollTop).toBe(600);
    tick();
    expect(element.scrollTop).toBeGreaterThan(300);
    expect(element.scrollTop).toBeLessThan(600);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(300, 0);
  });

  test("requesting the current position cancels an active animation", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    tick(4);
    expect(element.classList.contains("lenis-smooth")).toBe(true);
    const current = element.scrollTop;
    element.scrollTop = current;
    expect(element.classList.contains("lenis-smooth")).toBe(false);
    expect(element.classList.contains("lenis-scrolling")).toBe(false);
    tick(100);
    expect(element.scrollTop).toBe(current);
    expect(frames.size).toBe(0);
  });
});

describe("timeline motion with real Lenis", () => {
  test("intercepts the first write before observers run and retains physical getter identity", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    expect(element.scrollTop).toBe(0);
    expect(Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")!.get).toBe(
      original.get,
    );
    tick();
    const first = element.scrollTop;
    tick();
    expect(first).toBeGreaterThan(0);
    expect(element.scrollTop).toBeGreaterThan(first);
    expect(element.scrollTop).toBeLessThan(800);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(800, 0);
    expect(frames.size).toBe(0);
  });

  test("initial saved restoration survives layout replay capturing the transient origin", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline(0, 3472);
    element.scrollTop = 1440;
    time += 14;
    element.scrollTop = 16;
    time += 80;
    tick();
    element.scrollTop = 16;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1440, 0);
  });

  test("initial restoration permits revised layout destinations and bottom requests", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline(0, 3472);
    element.scrollTop = 1440;
    element.scrollTop = 1600;
    element.scrollTop = 16;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1600, 0);
    const other = timeline(0, 3472).element;
    other.scrollTop = 1440;
    other.scrollTop = 3472;
    tick(100);
    expect(other.scrollTop).toBeCloseTo(3472, 0);
  });

  test("initial origin protection expires and does not apply to later animations", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline(0, 3472);
    element.scrollTop = 1440;
    time += 251;
    element.scrollTop = 16;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(16, 0);
    element.scrollTop = 1440;
    element.scrollTop = 32;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(32, 0);
  });

  test("follows a growing maximum and repeated bottom requests without resetting progress", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 1000;
    tick(20);
    let previous = element.scrollTop;
    for (let i = 0; i < 20; i++) {
      geometry.max += 10;
      element.scrollTop = geometry.max;
      tick();
      expect(element.scrollTop).toBeGreaterThan(previous);
      expect(element.scrollTop).toBeLessThan(geometry.max);
      previous = element.scrollTop;
    }
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1200, 0);
  });

  test("does not classify initial restoration as prepend compensation", () => {
    const { element, geometry } = timeline(200);
    dispose = mountTimelineMotion(document);
    geometry.max += 300;
    element.scrollTop = 500;
    expect(element.scrollTop).toBe(200);
    tick(100);
    geometry.max += 300;
    element.scrollTop = 800;
    expect(element.scrollTop).toBe(800);
    geometry.max = 600;
    element.scrollTop = 600;
    expect(element.scrollTop).toBe(600);
  });

  test("wheel interrupts without preventing default and stale retries cannot take over the gesture", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 800;
    tick(3);
    const wheel = new view.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    element.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    geometry.top -= 100;
    const manual = element.scrollTop;
    element.scrollTop = 1000;
    tick(10);
    expect(element.scrollTop).toBe(manual);
    tick(10);
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(manual);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1000, 0);
  });

  test("a second animation after idle still takes multiple frames", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    tick(100);
    tick(600);
    element.scrollTop = 200;
    expect(element.scrollTop).toBe(800);
    tick();
    expect(element.scrollTop).toBeGreaterThan(200);
    expect(element.scrollTop).toBeLessThan(800);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(200, 0);
  });

  describe("explicit bottom-button activation", () => {
    test.each(["wheel", "touchstart", "pointerdown"])(
      "the bottom button takes over from %s input without waiting for manual idle",
      (type) => {
        dispose = mountTimelineMotion(document);
        const { root, element } = timeline(400);
        element.getBoundingClientRect = mock(() => new view.DOMRect(0, 0, 300, 200));
        const button = document.createElement("button");
        button.setAttribute("aria-label", "Scroll to latest event");
        button.innerHTML = "<span>Latest</span>";
        root.append(button);
        button.addEventListener("click", () => {
          element.scrollTop = 1000;
        });
        element.dispatchEvent(new view.MouseEvent(type, { bubbles: true, clientX: 295 }));
        button.firstElementChild!.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
        expect(element.scrollTop).toBe(400);
        tick();
        expect(element.scrollTop).toBeGreaterThan(400);
        expect(element.scrollTop).toBeLessThan(1000);
        tick(100);
        expect(element.scrollTop).toBeCloseTo(1000, 0);
      },
    );

    test("bottom-button activation only releases manual input in its own thread", () => {
      dispose = mountTimelineMotion(document);
      const first = timeline(400);
      const second = timeline(300);
      const button = document.createElement("button");
      button.setAttribute("aria-label", "Scroll to latest event");
      first.root.append(button);
      for (const { element } of [first, second]) {
        element.dispatchEvent(new view.WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      }
      const unrelated = document.createElement("button");
      first.root.append(unrelated);
      unrelated.click();
      first.element.scrollTop = 1000;
      expect(frames.size).toBe(0);
      button.addEventListener("click", () => {
        first.element.scrollTop = 1000;
        second.element.scrollTop = 1000;
      });
      button.click();
      tick(100);
      expect(first.element.scrollTop).toBeCloseTo(1000, 0);
      expect(second.element.scrollTop).toBe(300);
    });
  });

  test("a stalled frame cannot consume most of the visible transition", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    time += 500;
    tick();
    expect(element.scrollTop).toBeGreaterThan(0);
    expect(element.scrollTop).toBeLessThan(350);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(800, 0);
  });

  test("overlay scrollbar drags remain manual until pointer release", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.getBoundingClientRect = mock(() => new view.DOMRect(0, 0, 300, 200));
    element.scrollTop = 800;
    tick(2);
    element.dispatchEvent(new view.MouseEvent("pointerdown", { bubbles: true, clientX: 295 }));
    geometry.top = 100;
    tick(100);
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(100);
    view.dispatchEvent(new view.Event("pointerup"));
    tick(20);
    element.scrollTop = 1000;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1000, 0);
  });

  test("window blur releases a held scrollbar gesture after the manual grace period", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.getBoundingClientRect = mock(() => new view.DOMRect(0, 0, 300, 200));
    element.scrollTop = 800;
    tick(2);
    element.dispatchEvent(new view.MouseEvent("pointerdown", { bubbles: true, clientX: 295 }));
    geometry.top = 100;
    view.dispatchEvent(new view.Event("blur"));
    time += 249;
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(100);
    time += 2;
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(100);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1000, 0);
    expect(frames.size).toBe(0);
  });

  test("touch gestures stay native through a hold and release", () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    element.scrollTop = 800;
    tick(2);
    const touch = new view.Event("touchstart", { bubbles: true, cancelable: true });
    element.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    geometry.top = 100;
    tick(100);
    element.scrollTop = 1000;
    expect(element.scrollTop).toBe(100);
    element.dispatchEvent(new view.Event("touchend", { bubbles: true }));
    tick(20);
    element.scrollTop = 1000;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1000, 0);
  });

  test("editable navigation keys do not cancel, timeline navigation keys do", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    const input = document.createElement("textarea");
    element.firstElementChild!.append(input);
    element.scrollTop = 800;
    tick(2);
    const before = element.scrollTop;
    input.dispatchEvent(new view.KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    tick();
    expect(element.scrollTop).toBeGreaterThan(before);
    element.dispatchEvent(new view.KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
    const stopped = element.scrollTop;
    tick(100);
    expect(element.scrollTop).toBe(stopped);
  });

  test("navigation keys from the document body cancel the active timeline", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    tick(2);
    document.body.dispatchEvent(
      new view.KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }),
    );
    const stopped = element.scrollTop;
    tick(100);
    expect(element.scrollTop).toBe(stopped);
  });

  test("reduced motion changes settle the active destination and future writes immediately", () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.scrollTop = 800;
    tick(2);
    Object.assign(reduced, { matches: true });
    reduced.dispatchEvent(new view.Event("change"));
    expect(element.scrollTop).toBe(800);
    element.scrollTop = 200;
    expect(element.scrollTop).toBe(200);
    expect(frames.size).toBe(0);
    Object.assign(reduced, { matches: false });
    reduced.dispatchEvent(new view.Event("change"));
    element.scrollTop = 600;
    expect(element.scrollTop).toBe(200);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(600, 0);
  });

  test("unrelated containers and incomplete timeline markup stay native", () => {
    dispose = mountTimelineMotion(document);
    const unrelated = timeline(0, 1000, false).element;
    unrelated.scrollTop = 600;
    expect(unrelated.scrollTop).toBe(600);
    const incomplete = timeline().element;
    incomplete.querySelector(".scroll-bottom-anchor")!.remove();
    incomplete.scrollTop = 400;
    expect(incomplete.scrollTop).toBe(400);
    expect(frames.size).toBe(0);
  });

  test("abort and repeated unload restore the exact descriptor and stop ongoing writes", () => {
    const controller = new AbortController();
    dispose = mountTimelineMotion(document, controller.signal);
    const { element } = timeline();
    element.scrollTop = 800;
    tick(2);
    controller.abort();
    dispose();
    const stopped = element.scrollTop;
    tick(100);
    expect(element.scrollTop).toBe(stopped);
    expect(Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")).toEqual(original);
    expect(document.querySelector("[data-kitchen-sink-thread-scroll]")).toBeNull();
    expect(element.classList.contains("lenis")).toBe(false);
    expect(frames.size).toBe(0);
    element.scrollTop = 600;
    expect(element.scrollTop).toBe(600);
  });

  test("removed containers are detached and their preexisting classes are restored", async () => {
    const { root, element } = timeline();
    element.classList.add("lenis-existing");
    dispose = mountTimelineMotion(document);
    element.scrollTop = 800;
    tick();
    root.remove();
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    expect(element.classList.contains("lenis-existing")).toBe(true);
    const stopped = element.scrollTop;
    tick(100);
    expect(element.scrollTop).toBe(stopped);
  });

  test("unload preserves a later prototype patch", () => {
    dispose = mountTimelineMotion(document);
    const ours = Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")!;
    const later = {
      ...ours,
      set: mock(function (this: HTMLElement, value: number) {
        ours.set!.call(this, value);
      }),
    };
    Object.defineProperty(view.Element.prototype, "scrollTop", later);
    dispose();
    expect(Object.getOwnPropertyDescriptor(view.Element.prototype, "scrollTop")).toEqual(later);
    const { element } = timeline();
    element.scrollTop = 800;
    expect(element.scrollTop).toBe(800);
  });
});

describe("timeline discovery with real Lenis", () => {
  test("streaming mutations never rescan the document after mount", async () => {
    const { element } = timeline();
    const unrelated = document.createElement("aside");
    unrelated.innerHTML = "<div><span>Unrelated content</span></div>".repeat(100);
    document.body.append(unrelated);
    const scan = spyOn(document, "querySelectorAll");
    dispose = mountTimelineMotion(document);
    expect(scan).toHaveBeenCalledTimes(1);
    const row = element.firstElementChild!.firstElementChild!;
    for (let i = 0; i < 5; i++) {
      row.textContent = `Streaming update ${i}`;
      await Promise.resolve();
    }
    unrelated.append(document.createElement("div"));
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(element.classList.contains("lenis")).toBe(true);
  });

  test("direct anchors remain valid before trailing children without selector queries", () => {
    const { element } = timeline();
    const content = element.firstElementChild!;
    content.append(document.createElement("button"));
    const query = spyOn(content, "querySelector");
    dispose = mountTimelineMotion(document);
    element.scrollTop = 800;
    expect(element.scrollTop).toBe(0);
    tick(100);
    expect(element.scrollTop).toBeCloseTo(800, 0);
    expect(query).not.toHaveBeenCalled();
  });

  test("mount captures the maximum before a first-write shrink", () => {
    const { element, geometry } = timeline();
    dispose = mountTimelineMotion(document);
    geometry.max = 600;
    element.scrollTop = 300;
    expect(element.scrollTop).toBe(300);
    expect(frames.size).toBe(0);
  });

  test("discovery captures the maximum before a first-write shrink", async () => {
    dispose = mountTimelineMotion(document);
    const { element, geometry } = timeline();
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(true);
    geometry.max = 600;
    element.scrollTop = 300;
    expect(element.scrollTop).toBe(300);
    expect(frames.size).toBe(0);
  });

  test("staged markup registers as soon as the direct anchor arrives", async () => {
    dispose = mountTimelineMotion(document);
    const { element } = timeline();
    element.replaceChildren();
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    const content = document.createElement("div");
    element.append(content);
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    const anchor = document.createElement("div");
    anchor.className = "scroll-bottom-anchor";
    content.append(anchor);
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(true);
    element.scrollTop = 500;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(500, 0);
  });

  for (const state of ["idle", "animating"]) {
    test(`content replacement synchronously replaces an ${state} session once`, async () => {
      dispose = mountTimelineMotion(document);
      const { element } = timeline();
      element.scrollTop = 800;
      tick(state === "idle" ? 100 : 2);
      const added = spyOn(element, "addEventListener");
      const removed = spyOn(element, "removeEventListener");
      element.replaceChildren(element.firstElementChild!.cloneNode(true));
      element.scrollTop = 400;
      expect(removed.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
      expect(added.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
      await Promise.resolve();
      expect(removed.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
      expect(added.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
      tick(100);
      expect(element.scrollTop).toBeCloseTo(400, 0);
    });
  }

  test("invalidating an anchor immediately leaves writes native", () => {
    const { element } = timeline();
    dispose = mountTimelineMotion(document);
    element.firstElementChild!.lastElementChild!.classList.remove("scroll-bottom-anchor");
    element.scrollTop = 400;
    expect(element.scrollTop).toBe(400);
    expect(frames.size).toBe(0);
  });

  test("moving the anchor below a nested child detaches the active session", async () => {
    const { element } = timeline();
    dispose = mountTimelineMotion(document);
    element.scrollTop = 800;
    tick(2);
    const content = element.firstElementChild!;
    content.firstElementChild!.append(content.lastElementChild!);
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    element.scrollTop = 400;
    tick(100);
    expect(element.scrollTop).toBe(400);
    expect(frames.size).toBe(0);
  });

  test("removing the anchor detaches an idle session", async () => {
    const { element } = timeline();
    dispose = mountTimelineMotion(document);
    element.firstElementChild!.lastElementChild!.remove();
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    element.scrollTop = 400;
    expect(element.scrollTop).toBe(400);
  });

  test("removing thread scope immediately leaves writes native", () => {
    const { root, element } = timeline();
    dispose = mountTimelineMotion(document);
    root.removeAttribute("data-thread-window");
    element.scrollTop = 400;
    expect(element.scrollTop).toBe(400);
    expect(frames.size).toBe(0);
  });

  test("moving outside a thread window detaches the session", async () => {
    const { element } = timeline();
    dispose = mountTimelineMotion(document);
    document.body.append(element);
    element.scrollTop = 400;
    expect(element.scrollTop).toBe(400);
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    expect(frames.size).toBe(0);
  });

  test("removing an idle timeline through its ancestor detaches the session", async () => {
    const { root, element } = timeline();
    dispose = mountTimelineMotion(document);
    expect(element.classList.contains("lenis")).toBe(true);
    root.remove();
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(false);
    expect(frames.size).toBe(0);
  });

  test("removal and reinsertion in one batch preserves manual control", async () => {
    const { root, element, geometry } = timeline();
    dispose = mountTimelineMotion(document);
    element.dispatchEvent(new view.WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    geometry.top = 100;
    root.remove();
    document.body.append(root);
    await Promise.resolve();
    expect(element.classList.contains("lenis")).toBe(true);
    element.scrollTop = 800;
    expect(element.scrollTop).toBe(100);
    expect(frames.size).toBe(0);
  });

  test("nested additions are scanned only through their outer added subtree", async () => {
    dispose = mountTimelineMotion(document);
    const { root, element } = timeline();
    const outer = document.createElement("section");
    document.body.append(outer);
    outer.append(root);
    const outerScan = spyOn(outer, "querySelectorAll");
    const innerScan = spyOn(root, "querySelectorAll");
    await Promise.resolve();
    expect(outerScan).toHaveBeenCalledTimes(1);
    expect(innerScan).not.toHaveBeenCalled();
    expect(element.classList.contains("lenis")).toBe(true);
  });
});

describe("switching to a working thread", () => {
  test("opens a working thread at the bottom instead of its saved position", () => {
    dispose = mountTimelineMotion(document);
    const { root, element } = timeline(0, 3472);
    probe(root, true);
    element.scrollTop = 1440;
    expect(element.scrollTop).toBe(3472);
    tick(100);
    expect(element.scrollTop).toBe(3472);
  });

  test("returns a settled thread to its saved position", () => {
    dispose = mountTimelineMotion(document);
    const { root, element } = timeline(0, 3472);
    probe(root, false);
    element.scrollTop = 1440;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1440, 0);
  });

  test("leaves the saved position alone when no pane owns the timeline", () => {
    dispose = mountTimelineMotion(document);
    const { root, element } = timeline(0, 3472);
    probe(root.parentElement!, true, "thr_a");
    probe(root.parentElement!, true, "thr_b");
    element.scrollTop = 1440;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(1440, 0);
  });

  test("only the first restore is redirected; later scrolling stands", () => {
    dispose = mountTimelineMotion(document);
    const { root, element } = timeline(0, 3472);
    probe(root, true);
    element.scrollTop = 1440;
    expect(element.scrollTop).toBe(3472);
    element.scrollTop = 600;
    tick(100);
    expect(element.scrollTop).toBeCloseTo(600, 0);
  });
});

describe("thread activity", () => {
  test("reads any live work as working", () => {
    expect(isThreadWorking(sidebarThread({ indicator: "runtime" }))).toBe(true);
    expect(isThreadWorking(sidebarThread({ indicator: "working-draft" }))).toBe(true);
    expect(
      isThreadWorking(
        sidebarThread({
          activity: {
            workflows: 0,
            backgroundAgents: 1,
            backgroundCommands: 0,
            planMode: 0,
            goals: 0,
          },
        }),
      ),
    ).toBe(true);
  });

  test("reads a quiet thread as settled", () => {
    expect(isThreadWorking(sidebarThread({ indicator: "none" }))).toBe(false);
    expect(isThreadWorking(sidebarThread({ indicator: "draft" }))).toBe(false);
    expect(isThreadWorking(sidebarThread({ indicator: "waiting-for-input" }))).toBe(false);
  });
});
