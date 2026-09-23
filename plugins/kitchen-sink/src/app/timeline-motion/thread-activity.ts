/**
 * Which thread a timeline is showing, and whether that thread is working.
 *
 * bb puts no runtime status in the timeline's DOM, and a content script cannot
 * reach the SDK's thread hooks. So the plugin's thread-header slot writes both
 * facts onto a hidden marker inside each thread pane (see
 * `thread-activity-probe.tsx`), and the scroll router reads them back from
 * there. One marker per visible pane, so a split layout answers per pane
 * instead of for whichever thread happens to be focused.
 */

import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

export const PROBE_ATTRIBUTE = "data-kitchen-sink-thread";
export const PROBE_WORKING_ATTRIBUTE = "data-kitchen-sink-working";
export const PROBE_SELECTOR = `[${PROBE_ATTRIBUTE}]`;

/**
 * The statuses under which bb is still appending rows to the thread: the same
 * "busy" set bb's own list sorts to the top. `runtimeStatus` only refines
 * "active" (a busy thread whose host is provisioning or reconnecting), so it
 * never changes the answer. An unknown status reads as idle, per the DTO.
 */
const BUSY_STATUSES: ReadonlySet<PluginSidebarThread["status"]> = new Set([
  "starting",
  "active",
  "stopping",
]);

/**
 * Whether the reader is waiting on the agent: a turn is running, or a queued
 * message is about to start one. Read straight from the host's thread status
 * rather than inferred from indicator glyphs or activity counts.
 */
export function isThreadWorking(
  thread: Pick<PluginSidebarThread, "status" | "queuedWork">,
): boolean {
  return BUSY_STATUSES.has(thread.status) || thread.queuedWork === "waiting";
}

/**
 * Whether the thread drawn in this timeline is working right now.
 *
 * Climbs to the nearest ancestor that holds a marker: that is the pane, and in
 * a split layout it holds exactly one. An ancestor holding several means the
 * climb overshot into a container of panes, which cannot say which thread this
 * timeline belongs to — report not-working and let bb's saved position stand.
 */
export function isTimelineThreadWorking(timeline: HTMLElement): boolean {
  for (let node = timeline.parentElement; node; node = node.parentElement) {
    if (!node.querySelector(PROBE_SELECTOR)) continue;
    const probes = node.querySelectorAll(PROBE_SELECTOR);
    return probes.length === 1 && probes[0]?.getAttribute(PROBE_WORKING_ATTRIBUTE) === "true";
  }
  return false;
}
