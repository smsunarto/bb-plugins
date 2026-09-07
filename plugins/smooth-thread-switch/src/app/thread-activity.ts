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

export const PROBE_ATTRIBUTE = "data-smooth-thread-switch-thread";
export const PROBE_WORKING_ATTRIBUTE = "data-smooth-thread-switch-working";
export const PROBE_SELECTOR = `[${PROBE_ATTRIBUTE}]`;

/**
 * Any live work at all, foreground or background — the same reading of a
 * sidebar thread that decides whether the user is waiting on the agent.
 */
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
