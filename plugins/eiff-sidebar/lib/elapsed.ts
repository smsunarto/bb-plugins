const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** Compact whole-unit elapsed time for a working thread. */
export function elapsedLabel(sinceMs: number, now: number): string {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(now)) return "0s";

  const elapsed = Math.max(0, now - sinceMs);
  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / SECOND_MS)}s`;
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  return `${Math.floor(elapsed / HOUR_MS)}h`;
}
