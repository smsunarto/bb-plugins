import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PANEL_ACTION_ID } from "../../shared/panel.ts";
import { hostClient, resolveTarget } from "./target.ts";

const PLUGIN_ID = "gitbutler";
const OFFERED_KEY = "panelTabOffered";

/**
 * Add the GitButler tab to a thread's side panel the first time the thread
 * runs in a GitButler workspace, and never again. A reader who closes the tab
 * keeps it closed; the header button reopens it.
 *
 * The tab is written through the server's tab list rather than opened from
 * the app, so it appears without taking focus from whatever tab the reader
 * has selected. The tab id follows the app's own scheme so a later open from
 * the header focuses this tab instead of adding a second one.
 */
export async function offerPanelTab(bb: BbPluginApi, threadId: string): Promise<void> {
  const threads = bb.sdk.threads;
  const metadata = await threads.getPluginMetadata({ threadId, pluginId: PLUGIN_ID });
  if (metadata[OFFERED_KEY] === true) return;

  const { target } = await resolveTarget(bb, threadId);
  if (!target) return;
  const workspace = await hostClient(bb).call(
    "workspace",
    { environmentPath: target.environmentPath },
    { hostId: target.hostId },
  );
  if (workspace.state !== "ready") return;

  const current = await threads.tabs.get({ threadId });
  const present = current.tabs.some(
    (tab) =>
      tab.kind === "plugin-panel" && tab.pluginId === PLUGIN_ID && tab.actionId === PANEL_ACTION_ID,
  );
  if (!present) {
    await threads.tabs.update({
      threadId,
      expectedRevision: current.revision,
      tabs: [...current.tabs, panelTab()],
    });
  }
  await threads.updatePluginMetadata({
    threadId,
    pluginId: PLUGIN_ID,
    set: { [OFFERED_KEY]: true },
  });
}

function panelTab() {
  return {
    kind: "plugin-panel" as const,
    id: ["plugin-panel", encodeURIComponent(`${PLUGIN_ID}:${PANEL_ACTION_ID}:`), "none"].join(":"),
    pluginId: PLUGIN_ID,
    actionId: PANEL_ACTION_ID,
    title: "GitButler",
    paramsJson: null,
  };
}
