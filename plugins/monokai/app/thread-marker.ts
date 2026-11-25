import { createElement, useLayoutEffect } from "react";

import { markPage } from "./home-marker.ts";
import { usePanelOpensToNewTab } from "./panel-new-tab.ts";
import { registerThreadHeaderMarker } from "./thread-header-rows.ts";

// bb mounts one header row per thread pane. The theme floats the phone sidebar
// toggle while at least one pane is mounted.
const THREAD_ATTRIBUTE = "data-monokai-thread";

/**
 * Layout effect: the mark lands before the first paint, so the toggle never flashes.
 * The thread header is also the one per-thread mount, so it carries the panel's
 * open-to-new-tab behaviour (panel-new-tab.ts).
 */
export function ThreadMarker() {
  useLayoutEffect(() => markPage(document.documentElement, THREAD_ATTRIBUTE), []);
  usePanelOpensToNewTab();
  return createElement("span", { hidden: true, ref: registerThreadHeaderMarker });
}
