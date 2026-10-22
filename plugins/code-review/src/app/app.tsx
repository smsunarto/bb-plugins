import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { NeedsReviewCount } from "./inbox.tsx";
import { CodeReviewPage, InboxTab } from "./page.tsx";
import { PANEL_PATH } from "./format.ts";
import { mountLocalCache } from "./rpc.ts";
import { ReviewEmbed } from "./review-embed.tsx";
import "./code-review.css";

/** The sidebar row's count of pull requests waiting for the viewer's review. */
function SidebarAccessory() {
  return (
    <PluginQueryBoundary>
      <NeedsReviewCount />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "local-cache", mount: mountLocalCache });
  app.slots.messageDirective({ id: "code-review", component: ReviewEmbed });
  app.slots.navPanel({
    id: "code-review",
    title: "Code Review",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: CodeReviewPage,
    experimental_sidebarAccessory: SidebarAccessory,
    fixedTabs: [
      {
        panelId: "code-review",
        id: "inbox",
        title: "Inbox",
        icon: "GitPullRequest",
        component: InboxTab,
        layout: "flush",
      },
    ],
  });
});
