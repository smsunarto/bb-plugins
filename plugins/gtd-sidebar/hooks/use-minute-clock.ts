import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let minute = Math.floor(Date.now() / MINUTE_MS);
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === undefined) {
    minute = Math.floor(Date.now() / MINUTE_MS);
    timer = setInterval(() => {
      minute = Math.floor(Date.now() / MINUTE_MS);
      for (const notify of listeners) notify();
    }, MINUTE_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

const readMinute = () => minute;

/**
 * One clock for the list and every age label, quantized to the minute so they
 * agree on "now". Labels read it themselves, so a tick re-renders the labels
 * rather than every row.
 */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, readMinute) * MINUTE_MS;
}
