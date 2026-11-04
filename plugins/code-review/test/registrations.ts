import type { ComponentType } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

/** The Inbox bb shows in the left sidebar while the Review page is open, ready for `renderSlot`. */
export function inboxSidebarRegistration(app: CapturedPluginApp): {
  component: ComponentType<PluginNavPanelProps>;
} {
  const sidebar = app.navPanels.find((panel) => panel.id === "code-review")?.experimental_sidebar;
  if (!sidebar) throw new Error("Review registers no Inbox sidebar");
  return { component: sidebar };
}
