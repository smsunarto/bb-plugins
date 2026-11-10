/**
 * Windows a list of fixed-height items over its scroll container with
 * TanStack's virtual core, as gtd-sidebar's inbox does through
 * `@tanstack/react-virtual`. The core is used directly: the React adapter
 * imports `react-dom` for `flushSync`, which bb's plugin runtime does not
 * provide. Sizes are fixed per item kind, so nothing is measured; the
 * container's height comes from ResizeObserver entries and its offset from
 * scroll events, never from a layout read on mount.
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

export type ListWindow = {
  /** Null while every item mounts in flow. */
  items: VirtualItem[] | null;
  total: number;
};

export function useListWindow({
  count,
  sizeOf,
  keyOf,
  scrollElement,
  initialHeight = 800,
}: {
  count: number;
  sizeOf: (index: number) => number;
  keyOf: (index: number) => string;
  /** The scroll container, from a callback ref, so the window re-observes a new one. */
  scrollElement: HTMLElement | null;
  initialHeight?: number;
}): ListWindow {
  const windowed = count > WINDOW_AFTER;
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const options: Options = {
    count: windowed ? count : 0,
    getScrollElement: () => scrollElement,
    estimateSize: sizeOf,
    getItemKey: keyOf,
    overscan: OVERSCAN,
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
  if (!windowed) return { items: null, total: 0 };
  return { items: virtualizer.getVirtualItems(), total: virtualizer.getTotalSize() };
}
