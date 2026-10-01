/** Panel identity shared by the server tab writer and the client listener (design §3.6). */
export const PLUGIN_ID = "whiteboard";
export const WHITEBOARD_ICON = "whiteboard/whiteboard";
export const PANEL_ACTION_ID = "whiteboard";
export const NAV_PANEL_PATH = "whiteboard";

/** Key order matters: the client serializes params with plain JSON.stringify (plugin-json-value.ts:4-17). */
export const panelParamsJson = (sessionId: string): string => JSON.stringify({ sessionId });

/**
 * Must equal bb client's id for a plugin panel tab (desktop-v0.44.0 client-core
 * fixed-panel-tabs-state.ts:441-452, 537-552). A private client format (R4).
 */
export const panelTabId = (paramsJson: string | null): string =>
  [
    "plugin-panel",
    encodeURIComponent(`${PLUGIN_ID}:${PANEL_ACTION_ID}:${paramsJson ?? ""}`),
    "none",
  ].join(":");

/** Params the thread panel and the navPanel route carry. */
export type PanelParams = { sessionId?: string };

/** localStorage key for the Diff layout preference (design §3.8). */
export const DIFF_LAYOUT_STORAGE_KEY = "whiteboard:diff-layout";
