/**
 * Overview as the tab a Captain thread's side panel opens on. bb opens the
 * panel on the tab it remembers and then moves to its New tab page; the SDK
 * has no default-tab option. So each time the panel opens on a Captain thread,
 * this selects Overview in the same commit, before paint, which also keeps bb
 * from moving to New tab. It never opens the panel itself, and a tab picked
 * while the panel is open stays until the panel closes.
 */
import {
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
  experimental_usePluginId as usePluginId,
  type ExperimentalPanelTab,
  type ExperimentalPanelTabs,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useRef } from "react";

export const OVERVIEW_TAB = {
  id: "overview",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

/** What one panel observation asks for. */
export type OnOpen =
  /** Nothing to do: the panel did not just open, or Overview already shows. */
  | { kind: "none" }
  /** Select Overview: by its strip key, or by reference while the strip lacks it. */
  | { kind: "select"; overviewKey: string | null };

/**
 * Decide on one observation of the panel. `previous` is the last observation
 * for the same thread, or null for the first one: a thread whose panel is
 * already open when it is first seen opened before this watched it, so the
 * first observation is a baseline only.
 */
export function decideOnOpen(
  pluginId: string,
  previous: { open: boolean } | null,
  next: ExperimentalPanelTabs,
): OnOpen {
  if (previous === null || previous.open || !next.open) return { kind: "none" };
  const overview = next.tabs.find((tab) => isOverview(pluginId, tab));
  if (overview !== undefined && overview.key === next.selectedKey) return { kind: "none" };
  return { kind: "select", overviewKey: overview?.key ?? null };
}

function isOverview(pluginId: string, tab: ExperimentalPanelTab): boolean {
  return (
    tab.detail.kind === "plugin" &&
    tab.detail.pluginId === pluginId &&
    tab.detail.tab.id === OVERVIEW_TAB.id
  );
}

/** Watch this surface's panel for a Captain thread; mount it only on Captain threads. */
export function useOverviewOnOpen(threadId: string): void {
  const pluginId = usePluginId();
  const tabs = usePanelTabs();
  const panel = useAppPanel();
  const last = useRef<{ threadId: string; open: boolean } | null>(null);
  // A layout effect: bb's own pick and Overview land in one commit, before paint.
  useLayoutEffect(() => {
    const previous = last.current?.threadId === threadId ? last.current : null;
    last.current = { threadId, open: tabs.open };
    const decision = decideOnOpen(pluginId, previous, tabs);
    if (decision.kind !== "select") return;
    // Declined (the tab is hidden while its read loads): bb's pick stays this time.
    if (decision.overviewKey === null) panel.openTab({ tab: OVERVIEW_TAB });
    else panel.selectTab(decision.overviewKey);
  }, [panel, pluginId, tabs, threadId]);
}
