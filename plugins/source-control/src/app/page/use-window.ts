/**
 * Windows a list of fixed-height items with TanStack's virtual core, as
 * gtd-sidebar's inbox does through `@tanstack/react-virtual`. The core is used
 * directly: the React adapter imports `react-dom` for `flushSync`, which bb's
 * plugin runtime does not provide.
 *
 * The list does not own its scrolling. In bb's sidebar, bb scrolls the
 * sidebar body around the plugin's content, so the window follows whichever
 * ancestor scrolls, found once by its computed overflow (a style read, no
 * layout). Sizes are fixed per item kind, so nothing is measured; the
 * scroller's height and the list's offset in it are read in ResizeObserver
 * callbacks and scroll events, when layout is already clean.
 */
import {
  Virtualizer,
  elementScroll,
  type VirtualItem,
  type VirtualizerOptions,
} from "@tanstack/virtual-core";
import { useEffect, useLayoutEffect, useReducer, useState } from "react";

/** Below this many items every item mounts. */
export const WINDOW_AFTER = 50;
/** Items mounted past each edge of the viewport: about 700 px of rows. */
export const OVERSCAN = 12;

type Options = VirtualizerOptions<HTMLElement, Element>;

const parents = new WeakMap<HTMLElement, HTMLElement | null>();

/** The nearest ancestor that scrolls vertically: bb's sidebar body, or the page's column. Looked up once per list. */
export function scrollParent(element: HTMLElement): HTMLElement | null {
  if (parents.has(element)) return parents.get(element)!;
  let found: HTMLElement | null = null;
  for (let at = element.parentElement; at && !found; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") found = at;
  }
  parents.set(element, found);
  return found;
}

const observeRect: Options["observeElementRect"] = (instance, cb) => {
  const element = instance.scrollElement;
  if (!element || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver((entries) => {
    const box = entries.at(-1)?.contentRect;
    if (box) cb({ width: Math.round(box.width), height: Math.round(box.height) });
  });
  observer.observe(element);
  return () => observer.disconnect();
};

const observeOffset: Options["observeElementOffset"] = (instance, cb) => {
  const element = instance.scrollElement;
  if (!element) return;
  // After a scroll event layout is already clean, so this read is free.
  const onScroll = () => cb(element.scrollTop, false);
  element.addEventListener("scroll", onScroll, { passive: true });
  return () => element.removeEventListener("scroll", onScroll);
};

/**
 * Where the list starts inside its scroller, kept current from ResizeObserver
 * callbacks on both: they run after layout, so the reads there force none.
 */
function useScrollMargin(list: HTMLElement | null): number {
  const [margin, setMargin] = useState(0);
  useEffect(() => {
    const scroller = list ? scrollParent(list) : null;
    if (!list || !scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const top =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setMargin(Math.max(0, Math.round(top)));
    });
    observer.observe(list);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [list]);
  return margin;
}

export type ListWindow = {
  /** Null while every item mounts in flow. */
  items: VirtualItem[] | null;
  total: number;
  /** Subtract from an item's `start` to place it inside the list. */
  margin: number;
};

export function useListWindow({
  count,
  sizeOf,
  keyOf,
  list,
  initialHeight = 800,
}: {
  count: number;
  sizeOf: (index: number) => number;
  keyOf: (index: number) => string;
  /** The list's own element, from a callback ref; the window follows its scrolling ancestor. */
  list: HTMLElement | null;
  initialHeight?: number;
}): ListWindow {
  const windowed = count > WINDOW_AFTER;
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const margin = useScrollMargin(windowed ? list : null);
  const options: Options = {
    count: windowed ? count : 0,
    getScrollElement: () => (windowed && list ? scrollParent(list) : null),
    estimateSize: sizeOf,
    getItemKey: keyOf,
    overscan: OVERSCAN,
    scrollMargin: margin,
    initialRect: { width: 0, height: initialHeight },
    observeElementRect: observeRect,
    observeElementOffset: observeOffset,
    scrollToFn: elementScroll,
    onChange: () => rerender(),
  };
  const [virtualizer] = useState(() => new Virtualizer<HTMLElement, Element>(options));
  virtualizer.setOptions(options);
  useEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => {
    virtualizer._willUpdate();
  });
  if (!windowed) return { items: null, total: 0, margin: 0 };
  return { items: virtualizer.getVirtualItems(), total: virtualizer.getTotalSize(), margin };
}
