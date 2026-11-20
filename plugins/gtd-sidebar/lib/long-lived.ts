/**
 * Threads that stay open: never settled, never snoozed.
 *
 * bb has no "long-lived" flag on a thread, so the plugin that started one
 * decides. A Captain coordinates crew for days; settling or snoozing it would
 * hide the thread its crew report to. Waking or un-settling one stays
 * allowed, so a thread parked before this rule can still come back.
 */
import { rosterFamilyIds } from "./thread-family.ts";

type RosterThread = Parameters<typeof rosterFamilyIds>[0][number] & {
  originPluginId?: string | null;
};

/**
 * Origin plugins whose threads stay open. A literal rather than
 * `CAPTAIN_PLUGIN_ID`: the server imports this file, and captain-icons pulls
 * in the app SDK.
 */
export const LONG_LIVED_ORIGIN_PLUGIN_IDS: ReadonlySet<string> = new Set(["captain"]);

/** Why Settle and Snooze are unavailable on a long-lived thread. */
export const LONG_LIVED_REASON = "Captain threads stay open";

/** Why they are unavailable on a family that holds one. */
export const LONG_LIVED_FAMILY_REASON = "This family holds a Captain thread, which stays open";

export function isLongLivedThread(thread: { originPluginId?: string | null }): boolean {
  const origin = thread.originPluginId;
  return origin != null && LONG_LIVED_ORIGIN_PLUGIN_IDS.has(origin);
}

/**
 * Why a family may not be settled or snoozed, or null when it may. `members`
 * lists the root first, as `rosterFamilyIds` and `threadFamilyIds` do.
 */
export function stayOpenReason(
  members: readonly { originPluginId?: string | null }[],
): string | null {
  const [root, ...rest] = members;
  if (root !== undefined && isLongLivedThread(root)) return LONG_LIVED_REASON;
  return rest.some(isLongLivedThread) ? LONG_LIVED_FAMILY_REASON : null;
}

/**
 * `stayOpenReason` for `rootId`'s family as the sidebar's roster has it, the
 * family a snooze writes and bb's archive cascades to. A thread missing from
 * the roster is checked alone.
 */
export function rosterStayOpenReason(
  threads: readonly RosterThread[],
  rootId: string,
): string | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const members = rosterFamilyIds(threads, rootId).flatMap((id) => byId.get(id) ?? []);
  return stayOpenReason(members);
}
