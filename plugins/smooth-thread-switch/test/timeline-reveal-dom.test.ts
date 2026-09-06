import "./helpers/dom.ts";
import { SETTLE_QUIET_MS } from "../src/app/settle.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import {
  GHOST_CAP_MS,
  GHOST_CLASS,
  GHOST_MAX_MS,
  HOLD_CLASS,
  mountTimelineReveal,
  type FrameScheduler,
  type TimerScheduler,
} from "../src/app/timeline-reveal.ts";

/** jsdom brand-checks listener options, so signals must come from its own realm. */
function newController(): AbortController {
  return new window.AbortController();
}

function contextWith(signal: AbortSignal): PluginContentScriptContext {
  return { pluginId: "smooth-thread-switch", generation: 1, signal };
}

interface Pump {
  readonly frames: FrameScheduler;
  /** Runs every queued frame callback with the given timestamp. */
  tick(timestamp: number): void;
  pending(): number;
}

function createPump(): Pump {
  const queue: Array<{ id: number; callback: (timestamp: number) => void }> = [];
  let nextId = 1;
  return {
    frames: {
      request(callback) {
        const id = nextId++;
        queue.push({ id, callback });
        return id;
      },
      cancel(handle) {
        const index = queue.findIndex((entry) => entry.id === handle);
        if (index !== -1) queue.splice(index, 1);
      },
    },
    tick(timestamp) {
      for (const { callback } of queue.splice(0)) callback(timestamp);
    },
    pending: () => queue.length,
  };
}

interface Clock {
  readonly timers: TimerScheduler;
  /** Moves time forward, running every timer that comes due, in order. */
  advance(ms: number): void;
  pending(): number;
}

function createClock(): Clock {
  const queue: Array<{ id: number; due: number; callback: () => void }> = [];
  let now = 0;
  let nextId = 1;
  return {
    timers: {
      set(callback, delayMs) {
        const id = nextId++;
        queue.push({ id, due: now + delayMs, callback });
        return id;
      },
      clear(handle) {
        const index = queue.findIndex((entry) => entry.id === handle);
        if (index !== -1) queue.splice(index, 1);
      },
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        queue.sort((a, b) => a.due - b.due);
        const next = queue[0];
        if (next === undefined || next.due > until) break;
        queue.shift();
        now = next.due;
        next.callback();
      }
      now = until;
    },
    pending: () => queue.length,
  };
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** jsdom lays nothing out, so boxes are stubbed per element. */
function giveBox(element: HTMLElement, box: Box): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }),
  });
}

function stubScroll(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
}

interface Area {
  readonly element: HTMLElement;
  scrollTo(top: number): void;
}

function wrapArea(element: HTMLElement): Area {
  return {
    element,
    scrollTo(top) {
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        writable: true,
        value: top,
      });
      element.dispatchEvent(new window.Event("scroll"));
    },
  };
}

/** A conversation scroller. jsdom neither lays out nor scrolls, so metrics are stubbed. */
function installArea(scrollHeight = 2881, clientHeight = 1069): Area {
  document.body.innerHTML = '<div id="area" style="overflow-y: auto"></div>';
  const element = document.getElementById("area") as HTMLElement;
  stubScroll(element, scrollHeight, clientHeight);
  return wrapArea(element);
}

function mountRowList(area: Area): HTMLElement {
  const list = document.createElement("div");
  list.setAttribute("data-timeline-row-list", "top-level");
  area.element.append(list);
  return list;
}

interface Pane {
  /** The positioned page inset every absolute box lands in. */
  readonly inset: HTMLElement;
  /** The pane parent that survives a thread switch. */
  readonly parent: HTMLElement;
  /** Mounts a fresh pane wrapper with a scroll area and row list, as bb does per thread. */
  mountThread(scrollHeight?: number): { wrapper: HTMLElement; area: Area; list: HTMLElement };
}

const INSET_BOX: Box = { left: 0, top: 0, width: 390, height: 844 };
const AREA_BOX: Box = { left: 0, top: 48, width: 390, height: 796 };

/** bb's pane: a positioned inset, a parent that persists, and per-thread wrappers under it. */
function installPane(): Pane {
  document.body.innerHTML =
    '<div id="inset" style="position: relative"><div id="pane"></div></div>';
  const inset = document.getElementById("inset") as HTMLElement;
  const parent = document.getElementById("pane") as HTMLElement;
  giveBox(inset, INSET_BOX);
  return {
    inset,
    parent,
    mountThread(scrollHeight = 2881) {
      const wrapper = document.createElement("div");
      const element = document.createElement("div");
      element.style.overflowY = "auto";
      stubScroll(element, scrollHeight, 796);
      giveBox(element, AREA_BOX);
      const list = document.createElement("div");
      list.setAttribute("data-timeline-row-list", "top-level");
      element.append(list);
      wrapper.append(element);
      parent.append(wrapper);
      return { wrapper, area: wrapArea(element), list };
    },
  };
}

function ghostIn(root: ParentNode): HTMLElement | null {
  return root.querySelector(`.${GHOST_CLASS}`);
}

/** Lets jsdom deliver queued mutation records. */
function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  document.body.innerHTML = "";
});

interface MountSetup {
  readonly pump?: Pump;
  readonly clock?: Clock;
  readonly controller?: AbortController;
  /** jsdom's location never names a thread, so tests default to heading for one. */
  readonly openingThread?: () => boolean;
}

function mount(setup: MountSetup = {}): () => void | Promise<void> {
  const controller = setup.controller ?? newController();
  const dispose = mountTimelineReveal(contextWith(controller.signal), {
    frames: (setup.pump ?? createPump()).frames,
    timers: (setup.clock ?? createClock()).timers,
    openingThread: setup.openingThread ?? (() => true),
  });
  disposers.push(dispose);
  return dispose;
}

/** Positions a held list and waits through the quiet interval. */
function settle(pump: Pump, area: Area, from: number): void {
  pump.tick(from);
  area.scrollTo(1812);
  pump.tick(from + 16);
  pump.tick(from + 32);
  pump.tick(from + 48);
  pump.tick(from + 136);
}

describe("mountTimelineReveal", () => {
  test("hides a newly mounted row list until bb positions it, then shows the settled layout", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);

    pump.tick(0);
    pump.tick(16);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);

    area.scrollTo(1812);
    pump.tick(32);
    pump.tick(48);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    pump.tick(160);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });

  test("waits through row reflow even when scroll height stays the same", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea();
    const list = mountRowList(area);
    const row = document.createElement("div");
    list.append(row);
    giveBox(row, { left: 0, top: 0, width: 390, height: 120 });
    await flushMutations();
    area.scrollTo(1812);
    pump.tick(0);
    pump.tick(32);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    giveBox(row, { left: 0, top: 0, width: 358, height: 144 });
    pump.tick(100);
    pump.tick(100 + SETTLE_QUIET_MS - 1);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    pump.tick(100 + SETTLE_QUIET_MS);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
  });

  test("leaves rows streaming into an existing list alone", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea(1069, 1069);
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    pump.tick(16);
    pump.tick(128);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);

    const row = document.createElement("div");
    row.setAttribute("data-timeline-row-id", "row-1");
    list.append(row);
    await flushMutations();
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(row.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });

  test("finds a row list mounted inside a larger subtree, and ignores nested lists", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea();
    const window_ = document.createElement("div");
    window_.innerHTML =
      '<div><div data-timeline-row-list="top-level"><div data-timeline-row-list="child"></div></div></div>';
    area.element.append(window_);
    await flushMutations();
    const lists = area.element.querySelectorAll("[data-timeline-row-list]");
    expect(lists[0]?.classList.contains(HOLD_CLASS)).toBe(true);
    expect(lists[1]?.classList.contains(HOLD_CLASS)).toBe(false);
  });

  test("reveals at the cap when the view never leaves the top", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    pump.tick(200);
    pump.tick(340);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    pump.tick(810);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
  });

  test("drops a hold whose list unmounts before it settles", async () => {
    const pump = createPump();
    mount({ pump });
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    list.remove();
    pump.tick(16);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });

  test("a list outside any scroller is left alone", async () => {
    const pump = createPump();
    mount({ pump });
    document.body.innerHTML = "";
    const list = document.createElement("div");
    list.setAttribute("data-timeline-row-list", "top-level");
    document.body.append(list);
    await flushMutations();
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });

  test("the disposer strips every class, cancels frames, and stops observing", async () => {
    const pump = createPump();
    const dispose = mount({ pump });
    const area = installArea();
    const revealed = mountRowList(area);
    await flushMutations();
    settle(pump, area, 0);
    expect(revealed.classList.contains(HOLD_CLASS)).toBe(false);

    const held = mountRowList(area);
    await flushMutations();
    pump.tick(64);
    expect(held.classList.contains(HOLD_CLASS)).toBe(true);

    await dispose();
    expect(held.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);

    const later = mountRowList(area);
    await flushMutations();
    expect(later.classList.contains(HOLD_CLASS)).toBe(false);
  });

  test("the generation signal disposes the same way", async () => {
    const pump = createPump();
    const controller = newController();
    mount({ pump, controller });
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);

    controller.abort();
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });
});

describe("ghosting the outgoing conversation", () => {
  test("keeps the outgoing rows over the pane and swaps directly once the replacement settles", async () => {
    const pump = createPump();
    const clock = createClock();
    mount({ pump, clock });
    const pane = installPane();
    const outgoing = pane.mountThread();
    outgoing.list.innerHTML =
      '<div data-timeline-row-id="row-1" id="row-1"><iframe srcdoc="<p>hi</p>"></iframe></div>' +
      '<div data-scroll-footer=""></div>';
    await flushMutations();
    settle(pump, outgoing.area, 0);
    expect(outgoing.list.classList.contains(HOLD_CLASS)).toBe(false);
    outgoing.area.scrollTo(1700);

    // bb swaps the pane wrapper and mounts the replacement in one commit.
    outgoing.wrapper.remove();
    const incoming = pane.mountThread();
    await flushMutations();

    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();
    expect(ghost?.contains(outgoing.area.element)).toBe(true);
    expect(ghost?.getAttribute("inert")).toBe("");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.style.left).toBe("0px");
    expect(ghost?.style.top).toBe("48px");
    expect(ghost?.style.width).toBe("390px");
    expect(ghost?.style.height).toBe("796px");
    expect(outgoing.area.element.scrollTop).toBe(1700);
    expect(outgoing.area.element.style.height).toBe("100%");
    expect(
      ghost?.querySelector(
        "[data-timeline-row-list], [data-timeline-row-id], [id], [data-scroll-footer]",
      ),
    ).toBeNull();
    const frame = ghost?.querySelector("iframe");
    expect(frame?.hasAttribute("srcdoc")).toBe(false);
    expect(frame?.getAttribute("src")).toBe("about:blank");
    expect(incoming.list.classList.contains(HOLD_CLASS)).toBe(true);

    // Adopted: the cap no longer applies, only the hard ceiling remains.
    clock.advance(GHOST_CAP_MS + 1);
    expect(ghost?.isConnected).toBe(true);

    settle(pump, incoming.area, 100);
    expect(incoming.list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(ghost?.isConnected).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("a replacement that mounts later still adopts the retained view", async () => {
    const pump = createPump();
    const clock = createClock();
    mount({ pump, clock });
    const pane = installPane();
    const outgoing = pane.mountThread();
    await flushMutations();
    settle(pump, outgoing.area, 0);

    outgoing.wrapper.remove();
    await flushMutations();
    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();

    clock.advance(50);
    const incoming = pane.mountThread();
    await flushMutations();
    clock.advance(GHOST_CAP_MS);
    expect(ghost?.isConnected).toBe(true);

    settle(pump, incoming.area, 100);
    expect(ghost?.isConnected).toBe(false);
  });

  test("an outgoing conversation nobody replaces is removed at the cap", async () => {
    const pump = createPump();
    const clock = createClock();
    mount({ pump, clock });
    const pane = installPane();
    const outgoing = pane.mountThread();
    await flushMutations();
    settle(pump, outgoing.area, 0);

    outgoing.wrapper.remove();
    await flushMutations();
    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();
    clock.advance(GHOST_CAP_MS - 1);
    expect(ghost?.isConnected).toBe(true);
    clock.advance(1);
    expect(ghost?.isConnected).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test("no ghost outlives the hard ceiling, even while adopted", async () => {
    const pump = createPump();
    const clock = createClock();
    mount({ pump, clock });
    const pane = installPane();
    const outgoing = pane.mountThread();
    await flushMutations();
    settle(pump, outgoing.area, 0);

    outgoing.wrapper.remove();
    pane.mountThread();
    await flushMutations();
    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();
    clock.advance(GHOST_MAX_MS - 1);
    expect(ghost?.isConnected).toBe(true);
    clock.advance(1);
    expect(ghost?.isConnected).toBe(false);
  });

  test("a held list that unmounts leaves no ghost, and hands its ghost on", async () => {
    const pump = createPump();
    const clock = createClock();
    mount({ pump, clock });
    const pane = installPane();
    const first = pane.mountThread();
    await flushMutations();
    settle(pump, first.area, 0);

    first.wrapper.remove();
    const second = pane.mountThread();
    await flushMutations();
    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();
    pump.tick(100);
    expect(second.list.classList.contains(HOLD_CLASS)).toBe(true);

    // The reader switches again before the second thread ever shows.
    second.wrapper.remove();
    const third = pane.mountThread();
    await flushMutations();
    expect(pane.parent.querySelectorAll(`.${GHOST_CLASS}`).length).toBe(1);
    expect(ghostIn(pane.parent)).toBe(ghost);

    settle(pump, third.area, 200);
    expect(third.list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(ghost?.isConnected).toBe(false);
  });

  test("leaving threads altogether ghosts nothing", async () => {
    const pump = createPump();
    mount({ pump, openingThread: () => false });
    const pane = installPane();
    const thread = pane.mountThread();
    await flushMutations();
    settle(pump, thread.area, 0);

    thread.wrapper.remove();
    await flushMutations();
    expect(ghostIn(document.body)).toBeNull();
  });

  test("leaving threads during an unfinished switch removes the existing ghost", async () => {
    const pump = createPump();
    const clock = createClock();
    let opening = true;
    mount({ pump, clock, openingThread: () => opening });
    const pane = installPane();
    const first = pane.mountThread();
    await flushMutations();
    settle(pump, first.area, 0);
    first.wrapper.remove();
    const second = pane.mountThread();
    await flushMutations();
    expect(ghostIn(document.body)).not.toBeNull();

    opening = false;
    second.wrapper.remove();
    await flushMutations();
    expect(ghostIn(document.body)).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  test("a list that unmounts while its scroll area stays is not ghosted", async () => {
    const pump = createPump();
    mount({ pump });
    const pane = installPane();
    const thread = pane.mountThread();
    await flushMutations();
    settle(pump, thread.area, 0);

    thread.list.remove();
    await flushMutations();
    expect(ghostIn(document.body)).toBeNull();
    expect(thread.area.element.isConnected).toBe(true);
  });

  test("a conversation already open when the script mounts is ghosted on its first switch", async () => {
    const pump = createPump();
    const pane = installPane();
    const existing = pane.mountThread();
    existing.area.scrollTo(1812);
    mount({ pump });

    existing.wrapper.remove();
    pane.mountThread();
    await flushMutations();
    const ghost = ghostIn(pane.parent);
    expect(ghost).not.toBeNull();
    expect(existing.area.element.scrollTop).toBe(1812);
  });

  test("the disposer removes ghosts and their timers", async () => {
    const pump = createPump();
    const clock = createClock();
    const dispose = mount({ pump, clock });
    const pane = installPane();
    const outgoing = pane.mountThread();
    await flushMutations();
    settle(pump, outgoing.area, 0);

    outgoing.wrapper.remove();
    pane.mountThread();
    await flushMutations();
    expect(ghostIn(pane.parent)).not.toBeNull();

    await dispose();
    expect(ghostIn(document.body)).toBeNull();
    expect(clock.pending()).toBe(0);
    expect(pump.pending()).toBe(0);
  });
});
