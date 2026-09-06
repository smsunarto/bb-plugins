import "./helpers/dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import {
  HOLD_CLASS,
  REVEAL_CLASS,
  mountTimelineReveal,
  type FrameScheduler,
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

interface Area {
  readonly element: HTMLElement;
  scrollTo(top: number): void;
}

/** A conversation scroller. jsdom neither lays out nor scrolls, so metrics are stubbed. */
function installArea(scrollHeight = 2881, clientHeight = 1069): Area {
  document.body.innerHTML = '<div id="area" style="overflow-y: auto"></div>';
  const element = document.getElementById("area") as HTMLElement;
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
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

function mountRowList(area: Area): HTMLElement {
  const list = document.createElement("div");
  list.setAttribute("data-timeline-row-list", "top-level");
  area.element.append(list);
  return list;
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

function mount(pump: Pump, controller = newController()): () => void | Promise<void> {
  const dispose = mountTimelineReveal(contextWith(controller.signal), { frames: pump.frames });
  disposers.push(dispose);
  return dispose;
}

describe("mountTimelineReveal", () => {
  test("hides a newly mounted row list until bb positions it, then fades it in", async () => {
    const pump = createPump();
    mount(pump);
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);

    pump.tick(0);
    pump.tick(16);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);

    area.scrollTo(1812);
    pump.tick(32);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    pump.tick(48);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(list.classList.contains(REVEAL_CLASS)).toBe(true);
    expect(pump.pending()).toBe(0);
  });

  test("leaves rows streaming into an existing list alone", async () => {
    const pump = createPump();
    mount(pump);
    const area = installArea(1069, 1069);
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    pump.tick(16);
    expect(list.classList.contains(REVEAL_CLASS)).toBe(true);

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
    mount(pump);
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
    mount(pump);
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    pump.tick(200);
    pump.tick(340);
    expect(list.classList.contains(HOLD_CLASS)).toBe(true);
    pump.tick(360);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(list.classList.contains(REVEAL_CLASS)).toBe(true);
  });

  test("drops a hold whose list unmounts before it settles", async () => {
    const pump = createPump();
    mount(pump);
    const area = installArea();
    const list = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    list.remove();
    pump.tick(16);
    expect(list.classList.contains(HOLD_CLASS)).toBe(false);
    expect(list.classList.contains(REVEAL_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);
  });

  test("a list outside any scroller is left alone", async () => {
    const pump = createPump();
    mount(pump);
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
    const dispose = mount(pump);
    const area = installArea();
    const revealed = mountRowList(area);
    await flushMutations();
    pump.tick(0);
    area.scrollTo(1812);
    pump.tick(16);
    pump.tick(32);
    expect(revealed.classList.contains(REVEAL_CLASS)).toBe(true);

    const held = mountRowList(area);
    await flushMutations();
    pump.tick(48);
    expect(held.classList.contains(HOLD_CLASS)).toBe(true);

    await dispose();
    expect(held.classList.contains(HOLD_CLASS)).toBe(false);
    expect(revealed.classList.contains(REVEAL_CLASS)).toBe(false);
    expect(pump.pending()).toBe(0);

    const later = mountRowList(area);
    await flushMutations();
    expect(later.classList.contains(HOLD_CLASS)).toBe(false);
  });

  test("the generation signal disposes the same way", async () => {
    const pump = createPump();
    const controller = newController();
    mount(pump, controller);
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
