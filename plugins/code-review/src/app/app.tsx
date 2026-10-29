import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { useNeedsReviewBadge } from "./inbox.tsx";
import { CodeReviewPage, InboxTab } from "./page.tsx";
import { PANEL_PATH } from "./format.ts";
import { PrWatchBanner } from "./pr-watch.tsx";
import { mountLocalCache } from "./rpc.ts";
import { ReviewEmbed } from "./review-embed.tsx";
import { LandedEmbed } from "./landed-embed.tsx";
import { LANDED_DIRECTIVE } from "../shared/landed.ts";
import "./code-review.css";

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "local-cache", mount: mountLocalCache });
  app.slots.messageDirective({ id: "code-review", component: ReviewEmbed });
  // After work merges or reaches the default branch: what landed, and a button that settles the thread.
  app.slots.messageDirective({ id: LANDED_DIRECTIVE, component: LandedEmbed });
  // A card above the composer of a thread whose agent watches pull requests: their checks.
  app.composer.customize({
    id: "pr-watch",
    scopes: ["thread"],
    banners: [{ id: "pr-watch", component: PrWatchBanner }],
  });
  app.slots.navPanel({
    id: "code-review",
    title: "Review",
    icon: "code-review/plugin",
    path: PANEL_PATH,
    component: CodeReviewPage,
    experimental_useBadge: useNeedsReviewBadge,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "code-review" },
    availability: "fixed",
    id: "inbox",
    title: "Inbox",
    icon: "GitPullRequest",
    component: InboxTab,
    layout: "flush",
  });
});
