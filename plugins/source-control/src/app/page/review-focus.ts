/**
 * Which review item the reader last picked, and the way to show it: the rail
 * asks, the Files tab's diff column answers by scrolling to the item's
 * annotation. One per Change; a request made while no diff column is
 * mounted waits for the next one.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { ReviewItem } from "../../core/items.ts";

type Revealer = (item: ReviewItem) => void;

export class ReviewFocus {
  private focused: string | null = null;
  private readonly listeners = new Set<() => void>();
  private revealer: Revealer | null = null;
  private pending: ReviewItem | null = null;
  private whenDetached: Revealer | null = null;

  getFocused = (): string | null => this.focused;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Mark the item as the reader's, and scroll the diff to it. */
  reveal = (item: ReviewItem): void => {
    if (this.focused !== item.id) {
      this.focused = item.id;
      for (const listener of this.listeners) listener();
    }
    if (this.revealer) this.revealer(item);
    else {
      this.pending = item;
      this.whenDetached?.(item);
    }
  };

  /** Told when an item is picked with no diff column mounted, to bring one. */
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

/** Whether this item is the reader's last pick; redraws only the rows that change. */
export function useIsFocused(id: string): boolean {
  const focus = useContext(FocusContext);
  const subscribe = useCallback(
    (listener: () => void) => focus?.subscribe(listener) ?? (() => {}),
    [focus],
  );
  const get = useCallback(() => focus?.getFocused() === id, [focus, id]);
  return useSyncExternalStore(subscribe, get, get);
}
