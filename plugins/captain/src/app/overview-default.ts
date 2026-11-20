/**
 * Overview as the tab a Captain thread's side panel opens on. The SDK has no
 * default-tab option, so this watches the panel and, when it opens on a
 * Captain thread, selects Overview.
 *
 * Only a generic open moves: the panel toggle or its header button. bb shows
 * one of two things for it. Either the panel opens on Info or New tab, or it
 * reopens on the tab selected before and then moves to New tab moments
 * later. An open onto a destination gets neither: a file link, or a plugin
 * opening its own tab. It keeps its tab, even when that tab was the last one
 * selected. Overview is selected in the commit that shows bb's pick, before
 * paint.
 *
 * An open seen before bb has said whether this is a Captain thread waits for
 * that answer. It is dropped if the panel closes or the user picks another
 * tab meanwhile. This never opens the panel itself.
 */
import {
  experimental_useAppPanel as useAppPanel,
  experimental_usePanelTabs as usePanelTabs,
  experimental_usePluginId as usePluginId,
  type ExperimentalPanelTab,
  type ExperimentalPanelTabs,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useRef } from "react";

/** The tabs bb shows for a generic open. */
const FALLBACK_KINDS: ReadonlySet<string> = new Set(["info", "new-tab"]);

/**
 * How long after an open (or after bb names the thread a Captain's) its own
 * move to New tab still counts as part of the open. A New tab picked later is
 * the user's.
 */
export const SETTLE_MS = 500;

export const OVERVIEW_TAB = {
  id: "overview",
  context: { kind: "thread" },
  availability: "fixed",
} as const;

/** An open still being decided or still settling. */
export type Pending = {
  /** The tab bb showed as it opened. */
  selectedKey: string | null;
  /** A generic open: bb showed its fallback, or moved to it after. Unsure is a reopen on the last tab. */
  sure: boolean;
  /** When the settle window started; null while bb has not said whether this is a Captain thread. */
  at: number | null;
};

/** One thread's panel as last seen. */
export type Watch = {
  threadId: string;
  open: boolean;
  selectedKey: string | null;
  /** The tab selected when the panel was last seen open, for a bb that reports none while closed. */
  lastOpenKey: string | null;
  pending: Pending | null;
};

export type OnOpen =
  | { kind: "none" }
  /** Select Overview: by its strip key, or by reference while the strip lacks it. */
  | { kind: "select"; overviewKey: string | null };

/**
 * How the panel just opened, given the last observation of the same thread.
 * The first observation is a baseline: a panel already open then opened
 * before this watched it.
 */
export function classifyOpen(
  previous: Watch | null,
  next: ExperimentalPanelTabs,
): "none" | "generic" | "restored" | "explicit" {
  if (previous === null || previous.open || !next.open) return "none";
  if (isFallback(next)) return "generic";
  if (next.selectedKey === previous.selectedKey) return "restored";
  if (previous.selectedKey === null && next.selectedKey === previous.lastOpenKey) return "restored";
  return "explicit";
}

/**
 * Fold one observation into the watch and say what to do. `isCaptain` is null
 * while bb has not answered; `now` is a clock in milliseconds.
 */
export function observe(
  pluginId: string,
  prior: Watch | null,
  threadId: string,
  next: ExperimentalPanelTabs,
  isCaptain: boolean | null,
  now: number,
): { watch: Watch; action: OnOpen } {
  const previous = prior?.threadId === threadId ? prior : null;
  const overview = next.tabs.find((tab) => isOverview(pluginId, tab));
  const pending = settle(previous, next, overview, isCaptain, now);
  const watch: Watch = {
    threadId,
    open: next.open,
    selectedKey: next.selectedKey,
    lastOpenKey: next.open ? next.selectedKey : (previous?.lastOpenKey ?? null),
    pending,
  };
  const showing = overview !== undefined && overview.key === next.selectedKey;
  if (pending === null || !pending.sure || isCaptain !== true || showing) {
    return { watch, action: { kind: "none" } };
  }
  return { watch, action: { kind: "select", overviewKey: overview?.key ?? null } };
}

/** The open this observation still belongs to, if any. */
function settle(
  previous: Watch | null,
  next: ExperimentalPanelTabs,
  overview: ExperimentalPanelTab | undefined,
  isCaptain: boolean | null,
  now: number,
): Pending | null {
  if (isCaptain === false) return null;
  const at = isCaptain === null ? null : now;
  const opened = classifyOpen(previous, next);
  if (opened === "explicit") return null;
  if (opened !== "none") return { selectedKey: next.selectedKey, sure: opened === "generic", at };
  const pending = previous?.pending ?? null;
  if (pending === null || !next.open) return null;
  const started = pending.at ?? at;
  if (started !== null && now - started > SETTLE_MS) return null;
  const unchanged =
    next.selectedKey === pending.selectedKey ||
    (overview !== undefined && next.selectedKey === overview.key);
  // bb's own move to New tab marks the reopen as generic; any other pick is the user's.
  if (unchanged) return { ...pending, at: started };
  if (!isNewTab(next)) return null;
  // From here the open stands on New tab: a later pick of the tab it showed first is the user's.
  return { selectedKey: next.selectedKey, sure: true, at: started };
}

function isFallback(tabs: ExperimentalPanelTabs): boolean {
  const selected = tabs.tabs.find((tab) => tab.key === tabs.selectedKey);
  return selected === undefined || FALLBACK_KINDS.has(selected.detail.kind);
}

/** bb's New tab page, or no tab: where bb moves a toggled-open panel after showing its last tab. */
function isNewTab(tabs: ExperimentalPanelTabs): boolean {
  const selected = tabs.tabs.find((tab) => tab.key === tabs.selectedKey);
  return selected === undefined || selected.detail.kind === "new-tab";
}

function isOverview(pluginId: string, tab: ExperimentalPanelTab): boolean {
  return (
    tab.detail.kind === "plugin" &&
    tab.detail.pluginId === pluginId &&
    tab.detail.tab.id === OVERVIEW_TAB.id
  );
}

/**
 * Watch this surface's panel for a thread. Mount it before bb says whether
 * the thread is a Captain's, with `isCaptain` null until then, so an open in
 * that window is not missed.
 */
export function useOverviewOnOpen(threadId: string, isCaptain: boolean | null): void {
  const pluginId = usePluginId();
  const tabs = usePanelTabs();
  const panel = useAppPanel();
  const last = useRef<Watch | null>(null);
  // A layout effect: bb's own pick and Overview land in one commit, before paint.
  useLayoutEffect(() => {
    const { watch, action } = observe(
      pluginId,
      last.current,
      threadId,
      tabs,
      isCaptain,
      performance.now(),
    );
    last.current = watch;
    if (action.kind !== "select") return;
    // Declined (the tab is hidden while its read loads): the next change in the window tries again.
    if (action.overviewKey === null) panel.openTab({ tab: OVERVIEW_TAB });
    else panel.selectTab(action.overviewKey);
  }, [isCaptain, panel, pluginId, tabs, threadId]);
}
