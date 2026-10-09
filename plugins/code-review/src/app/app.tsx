import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { NeedsReviewCount } from "./inbox.tsx";
import { CodeReviewPage } from "./page.tsx";
import { PANEL_PATH } from "./format.ts";
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
  app.slots.navPanel({
    id: "code-review",
    title: "Code Review",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: CodeReviewPage,
    experimental_sidebarAccessory: SidebarAccessory,
  });
});
