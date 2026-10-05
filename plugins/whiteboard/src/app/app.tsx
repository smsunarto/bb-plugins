import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NAV_PANEL_PATH, PANEL_ACTION_ID, WHITEBOARD_ICON } from "../shared/contracts/panel.ts";
import { HomeHeader } from "./panel/home-header.tsx";
import { HomePanel } from "./panel/home-panel.tsx";
import { OpenListener } from "./panel/open-listener.tsx";
import { SessionPanel } from "./panel/session-panel.tsx";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Whiteboard",
    icon: WHITEBOARD_ICON,
    component: SessionPanel,
    layout: "flush",
  });
  app.slots.navPanel({
    id: NAV_PANEL_PATH,
    title: "Whiteboard",
    icon: WHITEBOARD_ICON,
    path: NAV_PANEL_PATH,
    component: HomePanel,
    headerContent: HomeHeader,
  });
  // Renders null: it only focuses the tab the server adds on `whiteboard:open` (design §3.6).
  app.slots.experimental_threadHeaderAction({
    id: "open-listener",
    title: "Whiteboard",
    component: OpenListener,
  });
});
