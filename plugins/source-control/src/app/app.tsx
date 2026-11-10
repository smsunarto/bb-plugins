import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ChangesTab } from "./changes-tab.tsx";
import { StripAction, StripSummary, useStripVisible } from "./composer-strip.tsx";
import { ReviewPanel, ReviewSidebar, useReviewBadge, useReviewTitle } from "./review-entry.tsx";

export default definePluginApp((app) => {
  // The thread's Change, in its Source Control tab. Shown for threads with an environment; the tab
  // reads only while it is the visible tab.
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "changes",
    title: "Source Control",
    icon: "GitBranch",
    component: ChangesTab,
    layout: "flush",
    useVisible: ({ environment }) => environment !== null,
  });
  // The Change in one line above the composer, for threads that have one.
  app.slots.experimental_threadContextSegment({
    id: "change",
    title: "Source Control",
    group: "2_pullRequest",
    order: 20,
    summary: StripSummary,
    action: StripAction,
    useVisible: useStripVisible,
  });
  // The review page, with the Changes nav as its sidebar.
  app.slots.navPanel({
    id: "source-control",
    title: "Source Control",
    path: "source-control",
    icon: "GitPullRequest",
    component: ReviewPanel,
    experimental_sidebar: ReviewSidebar,
    experimental_useBadge: useReviewBadge,
    experimental_usePageTitle: useReviewTitle,
  });
});
