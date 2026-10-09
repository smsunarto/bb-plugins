import { useState } from "react";

/**
 * A choice the reader makes once and expects kept across visits, like the
 * inbox tab or the diff layout. Stored in the window's localStorage under
 * `bb-plugin-code-review:<key>`. A stored value that is not one of `choices`
 * reads as `fallback`.
 */
export function useStoredChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const storageKey = `bb-plugin-code-review:${key}`;
  const [choice, setChoice] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return choices.find((each) => each === stored) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const choose = (next: T) => {
    setChoice(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // Storage can be unavailable in an embedded browser. The choice still
      // holds until the panel reloads.
    }
  };
  return [choice, choose];
}
