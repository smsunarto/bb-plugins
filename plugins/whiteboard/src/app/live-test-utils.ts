import type { LiveRead, LiveState } from "./live.ts";

/**
 * A live read a test drives in place of `useLiveRead`: `push` is an answer
 * and `fail` a failed attempt, as the SDK read would publish them.
 */
export function fakeLiveRead<T>() {
  let current: LiveState<T> | undefined;
  const listeners = new Set<(state: LiveState<T>) => void>();
  const publish = (state: LiveState<T>) => {
    current = state;
    for (const listener of Array.from(listeners)) listener(state);
  };
  const read: LiveRead<T> = {
    subscribe(listener) {
      listeners.add(listener);
      if (current) listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    read,
    push: (value: T) => publish({ value }),
    // SAFETY: followers only report the error; tests pass whatever the read would carry.
    fail: (error: unknown) => publish({ error: error as never }),
    /** How many followers are attached now. */
    followers: () => listeners.size,
  };
}
