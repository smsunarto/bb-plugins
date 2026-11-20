/**
 * Overview as a Captain thread's first panel tab. bb opens the side panel on
 * the tab it remembers for the thread, else on its own fallback (Info, or a
 * New tab page; bb adds its New tab launcher beside either). The SDK has no default-tab option, so the first time the
 * panel opens on a Captain thread without a remembered pick, this selects
 * Overview in the same commit, before paint, and records that it did. From
 * then on bb's own memory decides. It never opens the panel itself.
 */
import {
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
  experimental_usePluginId as usePluginId,
  type ExperimentalPanelTab,
  type ExperimentalPanelTabs,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useRef } from "react";

/** The tabs bb lands on when the thread has no remembered tab. */
const FALLBACK_KINDS: ReadonlySet<string> = new Set(["info", "new-tab"]);

export const OVERVIEW_TAB = {
  id: "overview",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

/** What one panel observation asks for. */
export type FirstOpen =
  /** Nothing to do: not a first open, or already handled. */
  | { kind: "none" }
  /** A remembered pick is showing: keep it, and stop watching this thread. */
  | { kind: "keep" }
  /** Select Overview: by its strip key, or by reference while the strip lacks it. */
  | { kind: "select"; overviewKey: string | null };

/**
 * Decide on one observation of the panel. `previous` is the last observation
 * for the same thread, or null for the first one: a thread whose panel is
 * already open when it is first seen opened before this watched it, so the
 * first observation is a baseline only.
 */
export function decideFirstOpen(
  pluginId: string,
  previous: { open: boolean } | null,
  next: ExperimentalPanelTabs,
  handled: boolean,
): FirstOpen {
  if (handled || previous === null || previous.open || !next.open) return { kind: "none" };
  const selected = next.tabs.find((tab) => tab.key === next.selectedKey);
  if (selected !== undefined && !FALLBACK_KINDS.has(selected.detail.kind)) return { kind: "keep" };
  const overview = next.tabs.find((tab) => isOverview(pluginId, tab));
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
export function useOverviewFirstOpen(threadId: string): void {
  const pluginId = usePluginId();
  const tabs = usePanelTabs();
  const panel = useAppPanel();
  const last = useRef<{ threadId: string; open: boolean } | null>(null);
  // A layout effect: bb's fallback and Overview land in one commit, before paint.
  useLayoutEffect(() => {
    const previous = last.current?.threadId === threadId ? last.current : null;
    last.current = { threadId, open: tabs.open };
    const key = flagKey(pluginId, threadId);
    const decision = decideFirstOpen(pluginId, previous, tabs, readFlag(key));
    if (decision.kind === "keep") writeFlag(key);
    if (decision.kind !== "select") return;
    const selected =
      decision.overviewKey === null
        ? panel.openTab({ tab: OVERVIEW_TAB })
        : panel.selectTab(decision.overviewKey);
    // Declined (the tab is hidden while its read loads): the next open tries again.
    if (selected) writeFlag(key);
  }, [panel, pluginId, tabs, threadId]);
}

const flagKey = (pluginId: string, threadId: string) => `${pluginId}:overview-opened:${threadId}`;

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage refused: the next open in this browser selects Overview again.
  }
}
