import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { NAV_PANEL_PATH, WHITEBOARD_ICON } from "../shared/contracts/panel.ts";
import { HomeHeader } from "./panel/home-header.tsx";
import { HomePanel } from "./panel/home-panel.tsx";
import { SessionPanel } from "./panel/session-panel.tsx";
import { WHITEBOARD_TAB, focusWhiteboard } from "./panel/whiteboard-tab.ts";

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...WHITEBOARD_TAB,
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
  // An agent's open adds the tab without focusing it; this button shows it.
  app.slots.experimental_threadAction({
    id: "open",
    title: "Open Whiteboard",
    icon: WHITEBOARD_ICON,
    group: "workspace",
    order: 20,
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Open Whiteboard",
      icon: WHITEBOARD_ICON,
      run: () => {
        focusWhiteboard(experimental_panel);
      },
    }),
  });
});
