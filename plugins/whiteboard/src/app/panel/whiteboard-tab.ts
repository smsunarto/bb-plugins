import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { PANEL_ACTION_ID, PLUGIN_ID } from "../../shared/contracts/panel.ts";

/** The thread Whiteboard tab, as `experimental_tab` registers it in app.tsx. */
export const WHITEBOARD_TAB = {
  id: PANEL_ACTION_ID,
  context: { kind: "thread" },
  availability: "action",
} as const;

type Panel = Pick<ExperimentalPanelController, "openTab" | "getTabs" | "selectTab">;

/** Open `sessionId`'s tab in the thread's side panel, or focus it when it is open. */
export function openSessionTab(
  panel: Pick<Panel, "openTab">,
  sessionId: string,
  title?: string,
): boolean {
  return panel.openTab({ tab: WHITEBOARD_TAB, params: { sessionId }, ...(title ? { title } : {}) });
}

/**
 * The header button: focus the thread's newest Whiteboard tab (an agent's
 * open appends one), or open Home in the tab when none is open.
 */
export function focusWhiteboard(panel: Panel): boolean {
  const open = panel
    .getTabs()
    .tabs.findLast(
      (tab) =>
        tab.detail.kind === "plugin" &&
        tab.detail.pluginId === PLUGIN_ID &&
        tab.detail.tab.id === PANEL_ACTION_ID,
    );
  return open ? panel.selectTab(open.key) : panel.openTab({ tab: WHITEBOARD_TAB });
}
