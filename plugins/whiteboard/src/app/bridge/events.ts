import type {
  ReviewDisposable,
  ReviewSurfaceEvent,
} from "../../shared/vendor/review-protocol/src/index.ts";

/**
 * In-panel navigation events. Code selection is owned by bb viewers (§0.1).
 */
export interface SurfaceEvents {
  emit(event: ReviewSurfaceEvent): void;
  subscribe(listener: (event: ReviewSurfaceEvent) => void): ReviewDisposable;
}

export function createSurfaceEvents(): SurfaceEvents {
  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();
  return {
    emit(event) {
      // A listener that unsubscribes another mid-emit must not skip it this round.
      for (const listener of Array.from(listeners)) {
        try {
          listener(event);
        } catch (error) {
          // One surface's handler must not starve the others.
          console.error("[whiteboard] surface event listener failed", error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
