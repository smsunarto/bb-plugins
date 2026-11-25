/**
 * Which review item or draft the reader last picked, and the way to show it:
 * the rail or the send tray asks, the Files tab's diff column answers by
 * scrolling to its annotation. One per Change; a request made while no diff
 * column is mounted waits for the next one.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { Anchor } from "../../core/items.ts";

/** Something drawn on the diff: `id` is its annotation's `data-sc-anchor`. A review item is one. */
export type Spot = { id: string; anchor: Anchor };
export type PagerDirection = -1 | 1;

type Revealer = (spot: Spot) => void;

export class ReviewFocus {
  private focused: string | null = null;
  private readonly listeners = new Set<() => void>();
  private revealer: Revealer | null = null;
  private pending: Spot | null = null;
  private pendingPagerFocus: PagerDirection | null = null;
  private whenDetached: Revealer | null = null;

  getFocused = (): string | null => this.focused;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Mark the spot as the reader's, and scroll the diff to it. */
  reveal = (spot: Spot, pagerFocus: PagerDirection | null = null): void => {
    this.pendingPagerFocus = null;
    if (this.focused !== spot.id) {
      this.focused = spot.id;
      for (const listener of this.listeners) listener();
    }
    if (this.revealer) this.revealer(spot);
    else {
      this.pending = spot;
      this.pendingPagerFocus = pagerFocus;
      this.whenDetached?.(spot);
    }
  };

  /** The replacement review bar takes focus once when a pager action changes tabs. */
  takePagerFocus(): PagerDirection | null {
    const direction = this.pendingPagerFocus;
    this.pendingPagerFocus = null;
    return direction;
  }

  /** Told when a spot is picked with no diff column mounted, to bring one. */
  onDetached(handler: Revealer): () => void {
    this.whenDetached = handler;
    return () => {
      if (this.whenDetached === handler) this.whenDetached = null;
    };
  }

  /** The diff column, while mounted. Takes a request made before it was. */
  attach(revealer: Revealer): () => void {
    this.revealer = revealer;
    const waiting = this.pending;
    this.pending = null;
    if (waiting) revealer(waiting);
    return () => {
      if (this.revealer === revealer) this.revealer = null;
    };
  }
}

export const FocusContext = createContext<ReviewFocus | null>(null);

/** Whether this spot is the reader's last pick; redraws only the rows that change. */
export function useIsFocused(id: string): boolean {
  const focus = useContext(FocusContext);
  const subscribe = useCallback(
    (listener: () => void) => focus?.subscribe(listener) ?? (() => {}),
    [focus],
  );
  const get = useCallback(() => focus?.getFocused() === id, [focus, id]);
  return useSyncExternalStore(subscribe, get, get);
}
