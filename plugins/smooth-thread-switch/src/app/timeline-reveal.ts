// @smsunarto/bb-plugin-smooth-thread-switch — hides a conversation while bb
// scrolls it into place, then fades it in.
//
// Switching threads remounts bb's timeline. The row list paints scrolled to
// the top, and only a few frames later does bb snap it to the bottom or back
// to the reader's saved row, sometimes reflowing once more as the latest rows
// merge in. This content script watches for a newly mounted top-level row
// list, holds it invisible while `advanceHold` judges the scroll geometry, and
// lifts the hold with a short fade. It changes nothing else: no scroll
// position, no bb state, only two classes on the list, which the disposer
// strips again.

import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";
import { INITIAL_HOLD_STATE, advanceHold, type HoldState } from "./settle.ts";

/** bb's top-level conversation row list; nested lists carry other values. */
const TOP_LEVEL_ROW_LIST_SELECTOR = '[data-timeline-row-list="top-level"]';
const ANY_ROW_LIST_SELECTOR = "[data-timeline-row-list]";

export const HOLD_CLASS = "smooth-thread-switch-hold";
export const REVEAL_CLASS = "smooth-thread-switch-reveal";

export interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
}

export interface MountOptions {
  /** Drives the per-frame sampling. Tests pass a hand-pumped scheduler. */
  readonly frames?: FrameScheduler;
}

interface Hold {
  readonly list: HTMLElement;
  readonly area: HTMLElement;
  state: HoldState;
  scrolled: boolean;
  startedAt: number | null;
  frame: number | null;
  detach: () => void;
}

const WINDOW_FRAMES: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

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

export function mountTimelineReveal(
  { signal }: PluginContentScriptContext,
  options: MountOptions = {},
): PluginContentScriptDisposer {
  const frames = options.frames ?? WINDOW_FRAMES;
  const holds = new Map<HTMLElement, Hold>();
  let disposed = signal.aborted;

  const release = (hold: Hold, reveal: boolean): void => {
    holds.delete(hold.list);
    if (hold.frame !== null) frames.cancel(hold.frame);
    hold.frame = null;
    hold.detach();
    hold.list.classList.remove(HOLD_CLASS);
    if (reveal) hold.list.classList.add(REVEAL_CLASS);
  };

  const step = (hold: Hold, timestamp: number): void => {
    hold.frame = null;
    if (!hold.list.isConnected) {
      release(hold, false);
      return;
    }
    hold.startedAt ??= timestamp;
    const { area } = hold;
    const next = advanceHold(
      hold.state,
      {
        scrollTop: area.scrollTop,
        scrollHeight: area.scrollHeight,
        clientHeight: area.clientHeight,
      },
      timestamp - hold.startedAt,
      hold.scrolled,
    );
    hold.state = next.state;
    if (next.reveal) {
      release(hold, true);
      return;
    }
    hold.frame = frames.request((nextTimestamp) => step(hold, nextTimestamp));
  };

  const begin = (list: HTMLElement): void => {
    if (disposed || holds.has(list)) return;
    const area = findScrollArea(list);
    if (area === null) return;
    // This runs in the mutation microtask, so the list is hidden before it
    // ever paints. A stale fade from an earlier hold would outrank the hide.
    list.classList.remove(REVEAL_CLASS);
    list.classList.add(HOLD_CLASS);
    const hold: Hold = {
      list,
      area,
      state: INITIAL_HOLD_STATE,
      scrolled: false,
      startedAt: null,
      frame: null,
      detach: () => {},
    };
    const markScrolled = (): void => {
      hold.scrolled = true;
    };
    area.addEventListener("scroll", markScrolled, { passive: true });
    hold.detach = () => area.removeEventListener("scroll", markScrolled);
    holds.set(list, hold);
    hold.frame = frames.request((timestamp) => step(hold, timestamp));
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const list of mountedRowLists(node)) begin(list);
      }
    }
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    for (const hold of holds.values()) release(hold, false);
    for (const element of document.querySelectorAll(`.${HOLD_CLASS}, .${REVEAL_CLASS}`)) {
      element.classList.remove(HOLD_CLASS, REVEAL_CLASS);
    }
  };

  if (disposed) return dispose;
  observer.observe(document.body, { childList: true, subtree: true });
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
