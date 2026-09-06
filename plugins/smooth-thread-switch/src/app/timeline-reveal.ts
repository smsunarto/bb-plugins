// Holds incoming rows through scroll restoration and layout changes, then
// swaps directly from the retained outgoing conversation to the settled one.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import {
  GhostRegistry,
  findAnchor,
  measurePlacement,
  type Ghost,
  type Placement,
  type TimerScheduler,
} from "./ghost.ts";
import { INITIAL_HOLD_STATE, advanceHold, type HoldState } from "./settle.ts";

export { GHOST_CAP_MS, GHOST_CLASS, GHOST_MAX_MS } from "./ghost.ts";
export type { TimerScheduler } from "./ghost.ts";

/** bb's top-level conversation row list; nested lists carry other values. */
const TOP_LEVEL_ROW_LIST_SELECTOR = '[data-timeline-row-list="top-level"]';
const ANY_ROW_LIST_SELECTOR = "[data-timeline-row-list]";

export const HOLD_CLASS = "smooth-thread-switch-hold";

export interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
}

export interface MountOptions {
  /** Drives the per-frame sampling. Tests pass a hand-pumped scheduler. */
  readonly frames?: FrameScheduler;
  /** Drives ghost expiry. Tests pass a hand-pumped scheduler. */
  readonly timers?: TimerScheduler;
  /** Whether the app is heading to a thread. Only those replace the outgoing rows with new ones. */
  readonly openingThread?: () => boolean;
}

/** A top-level row list, from mount to unmount. `hold` is null once it is revealed. */
interface Tracked {
  readonly list: HTMLElement;
  readonly area: HTMLElement;
  hold: HoldState | null;
  scrolled: boolean;
  scrollTop: number;
  placement: Placement | null;
  startedAt: number | null;
  frame: number | null;
  /** The outgoing conversation this one replaces, removed once this one reveals. */
  ghost: Ghost | null;
  detach: () => void;
}

const WINDOW_FRAMES: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

const WINDOW_TIMERS: TimerScheduler = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle),
};

/** bb's thread routes: /projects/<id>/threads/<id>, split views included. */
const THREAD_ROUTE = /\/threads\//;

function windowOpeningThread(): boolean {
  return THREAD_ROUTE.test(window.location.pathname);
}

/** The nearest scrolling ancestor of a row list, or null when nothing scrolls it. */
function findScrollArea(list: HTMLElement): HTMLElement | null {
  for (let element = list.parentElement; element !== null; element = element.parentElement) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return element;
  }
  return null;
}

/** The top-level row lists a mutation record just mounted. */
function mountedRowLists(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  if (node.matches(TOP_LEVEL_ROW_LIST_SELECTOR)) return [node];
  // Rows streaming into an existing list arrive as nodes inside it. Skip them
  // without a subtree query, which would otherwise run on every token.
  if (node.closest(ANY_ROW_LIST_SELECTOR) !== null) return [];
  return [...node.querySelectorAll<HTMLElement>(TOP_LEVEL_ROW_LIST_SELECTOR)];
}

function observeSize(area: HTMLElement, onResize: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(onResize);
  observer.observe(area);
  return () => observer.disconnect();
}

/** Scroll height alone misses row movement and mobile width changes. */
function measureRows(list: HTMLElement): string {
  return [list, ...list.children]
    .map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return `${x},${y},${width},${height}`;
    })
    .join(";");
}

export function mountTimelineReveal(
  { signal }: PluginContentScriptContext,
  options: MountOptions = {},
): PluginContentScriptDisposer {
  const frames = options.frames ?? WINDOW_FRAMES;
  const ghosts = new GhostRegistry(options.timers ?? WINDOW_TIMERS);
  const openingThread = options.openingThread ?? windowOpeningThread;
  const tracked = new Map<HTMLElement, Tracked>();
  let disposed = signal.aborted;

  const untrack = (entry: Tracked): void => {
    tracked.delete(entry.list);
    if (entry.frame !== null) frames.cancel(entry.frame);
    entry.frame = null;
    entry.detach();
  };

  /** Ends a hold. The list stays tracked for as long as it is in the document. */
  const release = (entry: Tracked, reveal: boolean): void => {
    entry.hold = null;
    if (entry.frame !== null) frames.cancel(entry.frame);
    entry.frame = null;
    entry.list.classList.remove(HOLD_CLASS);
    const { ghost } = entry;
    entry.ghost = null;
    if (reveal) {
      entry.placement = measurePlacement(entry.area);
      if (ghost !== null) ghosts.remove(ghost);
    } else if (ghost !== null) {
      ghosts.disown(ghost);
    }
  };

  const step = (entry: Tracked, timestamp: number): void => {
    entry.frame = null;
    if (entry.hold === null) return;
    if (!entry.list.isConnected) {
      release(entry, false);
      untrack(entry);
      return;
    }
    entry.startedAt ??= timestamp;
    const { area } = entry;
    const next = advanceHold(
      entry.hold,
      {
        scrollTop: area.scrollTop,
        scrollHeight: area.scrollHeight,
        clientHeight: area.clientHeight,
        layout: measureRows(entry.list),
      },
      timestamp - entry.startedAt,
      entry.scrolled,
    );
    entry.hold = next.state;
    if (next.reveal) {
      release(entry, true);
      return;
    }
    entry.frame = frames.request((nextTimestamp) => step(entry, nextTimestamp));
  };

  const track = (list: HTMLElement, hold: boolean): void => {
    if (disposed || tracked.has(list)) return;
    const area = findScrollArea(list);
    if (area === null) return;
    const entry: Tracked = {
      list,
      area,
      hold: hold ? INITIAL_HOLD_STATE : null,
      scrolled: false,
      scrollTop: area.scrollTop,
      placement: null,
      startedAt: null,
      frame: null,
      ghost: null,
      detach: () => {},
    };
    const onScroll = (): void => {
      entry.scrolled = true;
      entry.scrollTop = area.scrollTop;
    };
    const remeasure = (): void => {
      if (entry.hold === null) entry.placement = measurePlacement(area);
    };
    area.addEventListener("scroll", onScroll, { passive: true });
    const unobserveSize = observeSize(area, remeasure);
    entry.detach = () => {
      area.removeEventListener("scroll", onScroll);
      unobserveSize();
    };
    tracked.set(list, entry);
    if (!hold) {
      entry.placement = measurePlacement(area);
      return;
    }
    // This runs in the mutation microtask, so the list is hidden before it
    // ever paints.
    list.classList.add(HOLD_CLASS);
    entry.ghost = ghosts.adopt(area);
    entry.frame = frames.request((timestamp) => step(entry, timestamp));
  };

  /**
   * Covers the pane an outgoing conversation just left, unless the app is
   * leaving threads altogether or the replacement already shows.
   */
  const ghostOutgoing = (outgoing: Tracked): void => {
    const { placement, area } = outgoing;
    if (placement === null || area.isConnected || !openingThread()) return;
    const anchor = findAnchor(placement);
    if (anchor === null) return;
    let replacement: Tracked | null = null;
    for (const entry of tracked.values()) {
      if (anchor.contains(entry.area)) replacement = entry;
    }
    if (replacement !== null && (replacement.hold === null || replacement.ghost !== null)) return;
    if (ghosts.at(anchor) !== null) return;
    ghosts.create(area, placement, anchor, outgoing.scrollTop);
    if (replacement !== null) replacement.ghost = ghosts.adopt(replacement.area);
  };

  const observer = new MutationObserver((records) => {
    if (!openingThread()) ghosts.removeAll();
    // Outgoing panes first, so an incoming list in the same batch can adopt their ghost.
    for (const entry of tracked.values()) {
      if (entry.list.isConnected) continue;
      const revealed = entry.hold === null;
      release(entry, false);
      untrack(entry);
      if (revealed) ghostOutgoing(entry);
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const list of mountedRowLists(node)) track(list, true);
      }
    }
  });

  /** Re-measures the visible lists right before the interactions that switch threads. */
  const remeasureAll = (): void => {
    for (const entry of tracked.values()) {
      if (entry.hold === null && entry.list.isConnected) {
        entry.placement = measurePlacement(entry.area);
      }
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("pointerdown", remeasureAll, { capture: true });
    window.removeEventListener("resize", remeasureAll);
    for (const entry of tracked.values()) {
      release(entry, false);
      untrack(entry);
    }
    ghosts.removeAll();
    for (const element of document.querySelectorAll(`.${HOLD_CLASS}`)) {
      element.classList.remove(HOLD_CLASS);
    }
  };

  if (disposed) return dispose;
  for (const list of document.querySelectorAll<HTMLElement>(TOP_LEVEL_ROW_LIST_SELECTOR)) {
    track(list, false);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", remeasureAll, { capture: true, passive: true });
  window.addEventListener("resize", remeasureAll, { passive: true });
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
