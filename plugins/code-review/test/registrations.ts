import type { ComponentType } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

/** The fixed Inbox tab bb shows beside the Review page, ready for `renderSlot`. */
export function inboxTabRegistration(app: CapturedPluginApp): {
  component: ComponentType<PluginNavPanelProps>;
} {
  const tab = app.tabs.find(
    (candidate) =>
      candidate.id === "inbox" &&
      candidate.availability === "fixed" &&
      candidate.context.kind === "nav-panel" &&
      candidate.context.panelId === "code-review",
  );
  if (!tab) throw new Error("Review registers no fixed Inbox tab");
  return { component: tab.component as ComponentType<PluginNavPanelProps> };
}
