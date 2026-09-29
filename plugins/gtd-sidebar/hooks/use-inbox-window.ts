import type { RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  pinnedRowIndexes,
  type InboxWindowItem,
  type InboxWindowLayout,
} from "../lib/inbox-window";

/**
 * Rows mounted past each edge of the viewport. About 400px of cards, so a
 * fling reaches mounted rows before the next render lands.
 */
const OVERSCAN = 12;

/** A header's place in the list window, so the window measures it. */
export interface HeaderMeasureProps {
  measureRef: (element: Element | null) => void;
  measureIndex: number | undefined;
}

export interface InboxWindow {
  /** Flat indexes of the rows that mount this render. */
  mounted: ReadonlySet<number>;
  /** Ref for every mounted header and row wrapper; each carries `data-index`. */
  measureRef: (element: Element | null) => void;
  /** The height the items `from` to `to` (exclusive) take in the list. */
  span: (from: number, to: number) => number;
}

/**
 * Windows the thread list's rows over its scroll container.
 *
 * The list keeps its nested shape (shelves, project groups, rows), so sticky
 * shelf headers, whole-group sorting and the scroll clip all work as they do
 * with every row mounted. Only rows window: a run of unmounted rows becomes
 * one placeholder as tall as the rows it stands for. The virtualizer does the
 * bookkeeping over the flat item list, headers included, so every placeholder
 * is sized from the same measurements the range is computed from.
 */
export function useInboxWindow({
  layout,
  scrollRef,
  estimateSize,
  pinnedThreadIds,
}: {
  layout: InboxWindowLayout;
  scrollRef: RefObject<HTMLElement | null>;
  estimateSize: (item: InboxWindowItem) => number;
  /** Threads whose rows stay mounted wherever the list scrolls. */
  pinnedThreadIds: readonly (string | null | undefined)[];
}): InboxWindow {
  const { items } = layout;
  const pinned = pinnedRowIndexes(items, pinnedThreadIds);
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateSize(items[index]!),
    getItemKey: (index) => items[index]!.key,
    overscan: OVERSCAN,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...pinned])].sort((a, b) => a - b),
    measureElement: measureWithMargins,
    // A scroll re-renders the whole list; let React batch it. The overscan
    // covers the frame it waits.
    useFlushSync: false,
  });
  // Rows sit in normal flow, so a row resizing above the fold already moves
  // everything below it. The browser's scroll anchoring holds the viewport
  // still, as it does with every row mounted; the virtualizer adding its own
  // correction on top would jump the list by the same amount again.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const mounted = new Set<number>();
  for (const item of virtualizer.getVirtualItems()) {
    if (items[item.index]?.kind === "row") mounted.add(item.index);
  }
  const measurements = virtualizer.measurementsCache;
  return {
    mounted,
    measureRef: virtualizer.measureElement,
    span: (from, to) => measurements[to - 1]!.end - measurements[from]!.start,
  };
}

/**
 * An item's share of the list: its box plus its margins. Rows and project
 * headers space themselves with a top margin, so measuring the box alone
 * would leave every placeholder short by the gaps it replaces.
 */
function measureWithMargins(element: Element): number {
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().height +
    (Number.parseFloat(style.marginTop) || 0) +
    (Number.parseFloat(style.marginBottom) || 0)
  );
}
