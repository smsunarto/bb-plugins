import { useLayoutEffect } from "react";

import { markPage } from "./home-marker.ts";
import { usePanelOpensToNewTab } from "./panel-new-tab.ts";

// bb marks no route on the page, so an open thread announces itself: bb mounts
// thread-header actions only in a thread's header, and this one draws nothing.
// The theme floats the phone sidebar toggle only while the attribute is present.
const THREAD_ATTRIBUTE = "data-monokai-thread";

/** The slot title bb gives the action's wrapper; thread-marker.css hides it. */
export const THREAD_MARKER_TITLE = "Thread view marker";

/** bb still mounts the legacy thread-header slot; SDK 0.6.92 dropped its types. */
export interface LegacyThreadHeaderActionSlots {
  experimental_threadHeaderAction(registration: {
    id: string;
    title: string;
    component: () => null;
  }): void;
}

/**
 * Layout effect: the mark lands before the first paint, so the toggle never flashes.
 * The thread header is also the one per-thread mount, so it carries the panel's
 * open-to-new-tab behaviour (panel-new-tab.ts).
 */
export function ThreadMarker(): null {
  useLayoutEffect(() => markPage(document.documentElement, THREAD_ATTRIBUTE), []);
  usePanelOpensToNewTab();
  return null;
}
