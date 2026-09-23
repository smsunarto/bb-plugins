/**
 * The "Jump to latest event" command: a palette row with a default shortcut
 * that scrolls one thread's timeline to its live tail.
 *
 * The pane is found through the thread-header marker (`thread-activity.ts`),
 * so a split layout scrolls the pane showing `threadId` rather than whichever
 * is focused. bb's own "Scroll to latest event" button is preferred when it is
 * showing, because its click also resumes bottom following; otherwise the
 * timeline is sent to its bottom, which the scroll router animates.
 */

import { PROBE_ATTRIBUTE, PROBE_SELECTOR } from "./thread-activity.ts";

export const JUMP_TO_LATEST_COMMAND = {
  id: "jump-to-latest-event",
  title: "Jump to latest event",
  defaultShortcut: { key: "j", mod: true, shift: true },
} as const;

const TIMELINE = "[data-thread-window] .thread-scrollbar";
const LATEST_BUTTON = 'button[aria-label="Scroll to latest event"]';

/**
 * The timeline drawn beside `marker`. bb renders the thread header and the
 * thread window as siblings, so climb to the nearest ancestor holding a
 * timeline: that is the pane, and in a split layout it holds exactly one. An
 * ancestor holding several is a container of panes, which cannot say which
 * timeline belongs to the marker.
 */
function timelineBeside(marker: Element): HTMLElement | null {
  for (let node = marker.parentElement; node; node = node.parentElement) {
    const timelines = node.querySelectorAll<HTMLElement>(TIMELINE);
    if (timelines.length === 0) continue;
    return timelines.length === 1 ? (timelines[0] ?? null) : null;
  }
  return null;
}

/** Returns false when no pane on screen shows `threadId`. */
export function jumpToLatestEvent(document: Document, threadId: string): boolean {
  const marker = [...document.querySelectorAll(PROBE_SELECTOR)].find(
    (candidate) => candidate.getAttribute(PROBE_ATTRIBUTE) === threadId,
  );
  const timeline = marker ? timelineBeside(marker) : null;
  if (!timeline) return false;
  const button = timeline
    .closest("[data-thread-window]")
    ?.querySelector<HTMLButtonElement>(LATEST_BUTTON);
  if (button) {
    button.click();
    return true;
  }
  timeline.scrollTop = timeline.scrollHeight;
  return true;
}
