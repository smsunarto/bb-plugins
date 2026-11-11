import {
  definePluginApp,
  experimental_THREAD_INFO_ROW_GROUPS,
  experimental_THREAD_INFO_SECTION_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { ChangesTab } from "./changes-tab.tsx";
import { ChangeDirective } from "./chat-card.tsx";
import { DIRECTIVE_ID } from "../core/directive.ts";
import { LANDED_DIRECTIVE, LEGACY_LANDED_DIRECTIVE } from "../core/watch.ts";
import { LandedDirective } from "./landed-card.tsx";
import { PrWatchBanner } from "./pr-watch-banner.tsx";
import { LEGACY_REVIEW_DIRECTIVE, LegacyReviewDirective } from "./legacy-card.tsx";
import { StripAction, StripSummary, useStripVisible } from "./composer-strip.tsx";
import { ReviewPanel, ReviewSidebar, useReviewBadge, useReviewTitle } from "./review-entry.tsx";
import {
  BranchesInfoSection,
  headerActionItem,
  PullRequestInfoRow,
  useHeaderActionData,
} from "./thread-info.tsx";

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
  // "View in Source Control" in the header of a thread that has a checkout; nothing otherwise.
  app.slots.experimental_threadAction({
    id: "open",
    title: "Source Control",
    icon: "GitBranch",
    group: "workspace",
    order: 10,
    placement: "header",
    useData: useHeaderActionData,
    item: headerActionItem,
  });
  // The Info tab's GitButler branches, before bb's Commits (10): they name what those are on.
  app.slots.experimental_threadInfoSection({
    id: "branches",
    group: experimental_THREAD_INFO_SECTION_GROUPS.changes,
    order: 5,
    component: BranchesInfoSection,
  });
  // The Info tab's Pull request row for a GitButler thread, where bb's own reads gitbutler/workspace.
  app.slots.experimental_threadInfoRow({
    id: "pull-request",
    group: experimental_THREAD_INFO_ROW_GROUPS.pullRequest,
    order: 11,
    component: PullRequestInfoRow,
  });
  // A card above the composer of a thread whose agent watches pull requests: their checks, and
  // Unwatch. Mounted for every thread composer, so a thread with no watch reads one stored row.
  app.composer.customize({
    id: "pr-watch",
    scopes: ["thread"],
    banners: [{ id: "pr-watch", component: PrWatchBanner }],
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
  // The Change card an agent puts in its reply: `::source-control{key="…" revision="…"}`.
  // Drawn only where a message has the directive.
  app.slots.messageDirective({ id: DIRECTIVE_ID, component: ChangeDirective });
  // What a thread landed: `::source-control-landed{prs="…" commits="…" account="…"}`.
  app.slots.messageDirective({ id: LANDED_DIRECTIVE, component: LandedDirective });
  // Cards the retired Code Review plugin left in old threads. A directive id has one owner and
  // bb fails both registrations on a clash, so this commit assumes Code Review is disabled.
  // Rolling back means running Source Control from the commit before this one.
  app.slots.messageDirective({ id: LEGACY_REVIEW_DIRECTIVE, component: LegacyReviewDirective });
  app.slots.messageDirective({ id: LEGACY_LANDED_DIRECTIVE, component: LandedDirective });
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
