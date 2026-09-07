/**
 * The snooze lifecycle, as pure functions over stored rows.
 *
 * This state lives in the PLUGIN's own database, never on bb's thread. That
 * keeps a plugin concept out of bb's schema and out of the host-daemon
 * protocol, and uninstalling the plugin takes that database with it.
 */

import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

/** Any live work at all, whether it runs in the foreground or background. */
export function isThreadWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

export interface ThreadLifecycleRow {
  threadId: string;
  /** Wake time for a snooze; null when it is not snoozed. */
  snoozedUntil: number | null;
  /** When the snooze was set — used to detect activity since. */
  snoozedAt: number | null;
}

/** The activity signals that outrank a user's parking decision. */
export interface ThreadActivitySignals {
  hasPendingInteraction: boolean;
  /** Any live work: runtime, workflows, background agents, plan, goals. */
  isWorking: boolean;
  /** Newest attention timestamp bb reports for the thread. */
  latestAttentionAt: number;
}

export type ThreadShelf = "active" | "snoozed";

/**
 * Whether a thread may be parked at all.
 *
 * bb has more kinds of live work than a single session status — workflows,
 * background agents, background commands, plan mode, goals — and every one of
 * them must block parking. Hiding a thread that is still working is the one
 * failure this feature cannot afford.
 */
export function canPark(signals: ThreadActivitySignals): boolean {
  return !signals.hasPendingInteraction && !signals.isWorking;
}

/**
 * Which shelf a thread belongs on right now.
 *
 * Live work and a raised hand always win, so a snoozed thread that starts
 * working or asks a question comes straight back.
 */
export function resolveShelf(
  row: ThreadLifecycleRow | undefined,
  signals: ThreadActivitySignals,
  now: number,
): ThreadShelf {
  if (row === undefined || row.snoozedUntil === null) return "active";
  if (!canPark(signals)) return "active";

  // A timer that has elapsed wakes the thread; so does anything that
  // happened after the snooze was set.
  const wokeOnTimer = row.snoozedUntil <= now;
  const wokeOnActivity = row.snoozedAt !== null && signals.latestAttentionAt > row.snoozedAt;
  return wokeOnTimer || wokeOnActivity ? "active" : "snoozed";
}

/**
 * Whether a fresh list says exactly what the rows already on screen say.
 *
 * Most responses do: every realtime publish any window makes re-reads the
 * list, and most of those reads change nothing. Swapping the map in anyway
 * would re-partition and re-sort every thread, all to arrive back where the
 * screen already was.
 */
export function rowsMatch(
  current: ReadonlyMap<string, ThreadLifecycleRow>,
  next: readonly ThreadLifecycleRow[],
): boolean {
  if (current.size !== next.length) return false;
  return next.every((row) => {
    const existing = current.get(row.threadId);
    return (
      existing !== undefined &&
      existing.snoozedUntil === row.snoozedUntil &&
      existing.snoozedAt === row.snoozedAt
    );
  });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact "wakes in" label: "5m", "2h", "3d". Minutes round up so a snooze
 * never reads "0m" while the thread is still hidden.
 */
export function snoozeWakeLabel(snoozedUntil: number, now: number): string {
  const remaining = snoozedUntil - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) {
    return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  }
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

const MORNING_HOUR = 9;

/**
 * 09:00 on the next calendar day. Calendar arithmetic, not a fixed 24-hour
 * offset: a spring-forward day is 23 hours long, so the offset would land on
 * the wrong local day across a daylight-saving change.
 */
export function snoozeUntilTomorrow(now: Date): number {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next.getTime();
}

/**
 * `setTimeout` delays are signed 32-bit: a far-future wake overflows and fires
 * immediately, which turns one snooze into a tight re-arm loop. Clamped, the
 * timer simply re-arms every ~24.8 days until the wake is in range.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function nextWakeDelayMs(snoozedUntilValues: readonly number[], now: number): number | null {
  const upcoming = snoozedUntilValues.filter((value) => value > now);
  if (upcoming.length === 0) return null;
  const soonest = Math.min(...upcoming);
  return Math.min(Math.max(0, soonest - now) + 50, MAX_TIMEOUT_MS);
}

/**
 * How long to wait before re-reading a list whose read rejected, by attempt
 * number, and null once the attempts are spent.
 *
 * Neither list read has another way back from a rejection. A publish only
 * follows a mutation somebody makes, and the re-connect read needs the socket
 * to have actually dropped — a plugin backend that answers one request badly
 * over a channel that stays up produces neither, so without this a single blip
 * strands the mount for as long as the user leaves it open.
 *
 * Three retries inside seven seconds cover the blip. A backend that is properly
 * down is the reconnect path's problem, and a retry loop held open for it would
 * only spend requests hiding it.
 */
export const REFRESH_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

export function refreshRetryDelayMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= REFRESH_RETRY_DELAYS_MS.length) return null;
  return REFRESH_RETRY_DELAYS_MS[attempt] ?? null;
}
