import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { mountTimelineMotion } from "./timeline-motion.ts";

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
    expect(document.querySelector("[data-smooth-thread-scroll]")).toBeNull();
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
