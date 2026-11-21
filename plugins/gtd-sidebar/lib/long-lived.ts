/**
 * Threads that stay open: never settled, never snoozed.
 *
 * bb has no "long-lived" flag on a thread, so the plugin that started one
 * decides. A Captain coordinates crew for days; settling or snoozing it would
 * hide the thread its crew report to. Waking or un-settling one stays
 * allowed, so a thread parked before this rule can still come back.
 *
 * Only the thread itself is checked. A Captain is always a root (`bb captain
 * new` starts it top-level and nothing nests it), so no settle or snooze of
 * another thread's family reaches one.
 */

/**
 * Origin plugins whose threads stay open. A literal rather than
 * `CAPTAIN_PLUGIN_ID`: the server imports this file, and captain-icons pulls
 * in the app SDK.
 */
export const LONG_LIVED_ORIGIN_PLUGIN_IDS: ReadonlySet<string> = new Set(["captain"]);

/** Why Settle and Snooze are unavailable on a long-lived thread. */
export const LONG_LIVED_REASON = "Captain threads stay open";

export function isLongLivedThread(thread: { originPluginId?: string | null }): boolean {
  const origin = thread.originPluginId;
  return origin != null && LONG_LIVED_ORIGIN_PLUGIN_IDS.has(origin);
}

/** `LONG_LIVED_REASON` for a long-lived thread, else null. */
export function stayOpenReason(thread: { originPluginId?: string | null }): string | null {
  return isLongLivedThread(thread) ? LONG_LIVED_REASON : null;
}
