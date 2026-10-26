import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoSize } from "./inline-assets.ts";

/**
 * Sizes this client last saw, so a preview that remounts starts at its final
 * size instead of jumping. A preview remounts when its thread reopens, its
 * message scrolls back into view, or its card expands again. Each storage key
 * keeps its most recent entries.
 */
const LIMIT = 200;
const SAVE_DELAY_MS = 500;

function readAll<T>(storageKey: string, valid: (value: unknown) => value is T): Map<string, T> {
  try {
    const entries: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(entries)) return new Map();
    return new Map(
      entries.filter(
        (entry): entry is [string, T] =>
          Array.isArray(entry) && typeof entry[0] === "string" && valid(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

/** Map order is the recency order, so the oldest entries go first. */
function writeOne<T>(
  storageKey: string,
  valid: (value: unknown) => value is T,
  key: string,
  value: T,
): void {
  const entries = readAll(storageKey, valid);
  entries.delete(key);
  entries.set(key, value);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...entries].slice(-LIMIT)));
  } catch {
    // Storage can be unavailable; the preview then starts at its default size.
  }
}

const isHeight = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isVideoSize = (value: unknown): value is VideoSize =>
  typeof value === "object" &&
  value !== null &&
  isHeight((value as VideoSize).width) &&
  isHeight((value as VideoSize).height);

/** Display sizes of local videos, keyed by host and path. */
export function videoSizes(storageKey: string) {
  return {
    read: (key: string) => readAll(storageKey, isVideoSize).get(key),
    write: (key: string, size: VideoSize) => writeOne(storageKey, isVideoSize, key, size),
  };
}

/**
 * The height `key` had when it was last shown, and a setter that saves at
 * most every half second and once more on unmount, so a quick remount reads it.
 */
export function useRememberedHeight(
  storageKey: string,
  key: string,
): [number | undefined, (height: number) => void] {
  const [remembered] = useState(() => readAll(storageKey, isHeight).get(key));
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current === null) return;
    writeOne(storageKey, isHeight, key, pending.current);
    pending.current = null;
  }, [storageKey, key]);
  useEffect(() => flush, [flush]);
  const remember = useCallback(
    (height: number) => {
      pending.current = height;
      timer.current ??= setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );
  return [remembered, remember];
}
