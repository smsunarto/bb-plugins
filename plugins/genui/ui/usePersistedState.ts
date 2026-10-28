// State a component keeps for the user inside its own UI (weights they tuned,
// steps they unchecked, numbers they changed) without a `$state` in the spec.
// BB's timeline unmounts rows that scroll out of view and remounts them on the
// way back, so plain useState would lose the user's changes; this keeps them
// per block in localStorage (or in memory where nothing persists: the gallery).
import { useCallback, useState } from "react";
import { useUiRuntime } from "./runtime";

/** Where `blockKey` is null (the gallery): survives remounts, not reloads. */
const MEMORY = new Map<string, unknown>();

/** FNV-1a over the JSON of a value: a stable id for a component within its block. */
export function propsKey(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Like useState, but kept across remounts and reloads for this block. `id`
 * names the state within the block: use `propsKey(props)` plus a suffix, so
 * two components in one block keep apart and a changed spec starts fresh.
 * `accept` checks a stored value (old data, other versions) and returns it,
 * or null to fall back to `initial`. Values must survive JSON.
 */
export function usePersistedState<T>(
  id: string,
  initial: T,
  accept: (stored: unknown) => T | null,
): [T, (next: T | ((previous: T) => T)) => void] {
  const { blockKey } = useUiRuntime();
  const key = blockKey === null ? null : `${blockKey}:local:${id}`;
  const [value, setValue] = useState<T>(() => {
    const stored = key === null ? MEMORY.get(id) : readStored(key);
    return stored === undefined ? initial : (accept(stored) ?? initial);
  });
  const update = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
        if (key === null) MEMORY.set(id, resolved);
        else {
          try {
            localStorage.setItem(key, JSON.stringify(resolved));
          } catch {
            // Storage full or blocked: the change still applies for this page.
          }
        }
        return resolved;
      });
    },
    [id, key],
  );
  return [value, update];
}
