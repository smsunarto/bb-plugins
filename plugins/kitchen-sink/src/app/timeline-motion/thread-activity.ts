/**
 * Which thread a pane is showing.
 *
 * bb's timeline DOM does not name its thread, so the plugin's thread-header
 * slot writes the id onto a hidden marker inside each thread pane (see
 * `thread-activity-probe.tsx`), and "Jump to latest event" reads it back to
 * find the pane. One marker per visible pane, so a split layout answers per
 * pane instead of for whichever thread happens to be focused.
 */

export const PROBE_ATTRIBUTE = "data-kitchen-sink-thread";
export const PROBE_SELECTOR = `[${PROBE_ATTRIBUTE}]`;
