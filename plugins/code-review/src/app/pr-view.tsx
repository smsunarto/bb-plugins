import { UrlLink, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { PR_TABS, prKey, prSubPath, sameRef } from "../shared/schema.ts";
import type { Checks, Inbox, InboxPr, PrRef, PrTab, PullRequest } from "../shared/schema.ts";
import { ChangesTab } from "./changes.tsx";
import { ChecksTab, useChecks } from "./checks.tsx";
import { ReviewWithCodexButton } from "./codex-review.tsx";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { PANEL_PATH, plural } from "./format.ts";
import { useInbox } from "./inbox.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, Tip, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { Avatar, ChecksStateIcon, PrStateBadge, Timestamp, checksLabel } from "./status.tsx";
import { SubmitReviewButton } from "./submit-review.tsx";
import { SummaryTab } from "./summary.tsx";

/** How often an open pull request is read again, for new pushes, reviews, and comments. */
const PR_REFRESH_MS = 60_000;

const TAB_LABEL: Record<PrTab, string> = {
  summary: "Summary",
  changes: "Changes",
  checks: "Checks",
};

const ICON_BUTTON = cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "text-muted-foreground");

function useBackToInbox(): () => void {
  const navigate = useBbNavigate();
  return () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
}

/** The right pane: one pull request's header, toolbar, and tabs. The tab lives in the URL. */
export function PrView({ prRef, tab }: { prRef: PrRef; tab: PrTab }) {
  const pullRequest = rpc.pullRequest.useQuery(
    { ref: prRef },
    { staleTime: 15_000, refetchInterval: PR_REFRESH_MS },
  );
  const back = useBackToInbox();
  const pr = pullRequest.data;
  if (!pr) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <BackButton />
          <span className="truncate text-muted-foreground">{prKey(prRef)}</span>
        </div>
        <div className="p-4">
          {pullRequest.isError ? (
            <Notice
              tone="error"
              title={`Could not open ${prKey(prRef)}`}
              action={
                <>
                  <RetryButton onRetry={() => void pullRequest.refetch()} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2.5 text-xs font-normal"
                    onClick={back}
                  >
                    Back to inbox
                  </Button>
                </>
              }
            >
              {errorText(pullRequest.error)}
            </Notice>
          ) : (
            <Loading label={`Loading ${prKey(prRef)}…`} rows={5} />
          )}
        </div>
      </div>
    );
  }
  return <Loaded pr={pr} tab={tab} />;
}

/** Narrow, the pull request fills the page, so this is the way back to the list. */
function BackButton() {
  const back = useBackToInbox();
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(ICON_BUTTON, "-ms-1.5 shrink-0 @3xl/page:hidden")}
      aria-label="Back to inbox"
      onClick={back}
    >
      <Icon name="ChevronLeft" aria-hidden />
    </Button>
  );
}

function Loaded({ pr, tab }: { pr: PullRequest; tab: PrTab }) {
  const navigate = useBbNavigate();
  const checks = useChecks(pr.ref, pr.headRefOid);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) =>
        navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(pr.ref, value as PrTab) })
      }
      // The tab is in the URL, so arrow keys only move focus: each selection is a history entry.
      activationMode="manual"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="shrink-0 border-b border-border bg-background px-3 pt-2.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-1">
            <BackButton />
            <h1 className="min-w-0 text-sm leading-snug font-semibold [overflow-wrap:anywhere]">
              {pr.title}{" "}
              <span className="font-normal text-muted-foreground tabular-nums">
                #{pr.ref.number}
              </span>
            </h1>
          </div>
          <Toolbar pr={pr} />
        </div>
        <Meta pr={pr} />
        <TabsList
          aria-label="View"
          className="mt-2 -mb-px h-auto justify-start gap-3 rounded-none bg-transparent p-0"
        >
          {PR_TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                "h-8 gap-1.5 rounded-none border-b-2 border-transparent px-0.5 py-0 text-xs font-medium text-muted-foreground",
                "hover:text-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none",
              )}
            >
              {TAB_LABEL[value]}
              {value === "changes" ? (
                <span className="text-subtle-foreground tabular-nums">{pr.changedFiles}</span>
              ) : null}
              {value === "checks" && checks.data?.state ? (
                <ChecksStateIcon
                  state={checks.data.state}
                  label={`Checks: ${checksLabel(checks.data.state)}`}
                  className="size-3"
                />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </header>
      <TabsContent value="summary" className={PANE}>
        <SummaryTab pr={pr} />
      </TabsContent>
      <TabsContent value="changes" className={FILL}>
        <ChangesTab pr={pr} />
      </TabsContent>
      <TabsContent value="checks" className={PANE}>
        <ChecksTab pr={pr} />
      </TabsContent>
    </Tabs>
  );
}

// Summary and Checks scroll on their own below the header, which stays put.
// The gutter is reserved so a tab that grows a scrollbar does not shift
// sideways. Changes lays out its own file list and scroll area, so it gets
// the whole space, unpadded.
const TAB_PANE = "mt-0 min-h-0 flex-1 focus-visible:ring-0 focus-visible:ring-offset-0";
const PANE = `${TAB_PANE} overflow-y-auto p-3 pb-8 [scrollbar-gutter:stable]`;
const FILL = `${TAB_PANE} flex flex-col overflow-hidden`;

function Meta({ pr }: { pr: PullRequest }) {
  const sameRepo =
    !pr.headRepository ||
    pr.headRepository.toLowerCase() === `${pr.ref.owner}/${pr.ref.repo}`.toLowerCase();
  const head = sameRepo
    ? pr.headRefName
    : `${pr.headRepository?.split("/")[0] ?? ""}:${pr.headRefName}`;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
      <PrStateBadge state={pr.state} isDraft={pr.isDraft} />
      <span>
        {pr.ref.owner}/{pr.ref.repo}
      </span>
      <span className="flex min-w-0 items-center gap-1 font-mono" translate="no">
        <span className="sr-only">Merging </span>
        <span className="truncate rounded bg-secondary px-1 text-foreground" title={head}>
          {head}
        </span>
        <Icon name="ArrowRight" className="size-3 shrink-0" aria-hidden />
        <span className="sr-only"> into </span>
        {/* The base is usually short and says where this lands, so the head gives way first. */}
        <span
          className="max-w-40 shrink-0 truncate rounded bg-secondary px-1 text-foreground"
          title={pr.baseRefName}
        >
          {pr.baseRefName}
        </span>
      </span>
      {pr.author ? (
        <span className="flex items-center gap-1">
          <Avatar login={pr.author.login} url={pr.author.avatarUrl} className="size-3.5" />
          <span className="text-foreground">{pr.author.login}</span>
          opened
          <Timestamp iso={pr.createdAt} />
        </span>
      ) : null}
      <span className="flex items-center gap-1.5 tabular-nums">
        <span className="text-diff-added" aria-label={`${pr.additions} lines added`}>
          +{pr.additions}
        </span>
        <span className="text-diff-removed" aria-label={`${pr.deletions} lines removed`}>
          −{pr.deletions}
        </span>
        <span>{plural(pr.changedFiles, "file")}</span>
      </span>
    </div>
  );
}

function Toolbar({ pr }: { pr: PullRequest }) {
  return (
    <div
      role="toolbar"
      aria-label="Pull request actions"
      className="flex shrink-0 items-center gap-1"
    >
      <PinButton pr={pr} />
      <Tip label="Open on GitHub">
        <UrlLink
          href={pr.url}
          aria-label="Open on GitHub"
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), ICON_BUTTON)}
        >
          <Icon name="ExternalLink" aria-hidden />
        </UrlLink>
      </Tip>
      <ReviewWithCodexButton pr={pr} />
      <SubmitReviewButton pr={pr} />
    </div>
  );
}

/** What the inbox would say about this pull request, for a pin added before the inbox is read again. */
function inboxEntry(pr: PullRequest, checks: Checks | undefined): InboxPr {
  const own = pr.reviewers.find(
    (reviewer) => reviewer.kind === "user" && reviewer.name === pr.viewer.login,
  );
  return {
    ref: pr.ref,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    author: pr.author,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    reviewDecision: pr.reviewDecision,
    checks: checks?.state ?? null,
    viewerReview: pr.pendingReview
      ? "pending"
      : own && own.state !== "requested"
        ? own.state
        : null,
    reviewRequestedFromViewer: own?.state === "requested",
  };
}

/**
 * Pins show in the inbox at once: the cached inbox is changed before the
 * server answers, put back if it refuses, and read again either way.
 */
function PinButton({ pr }: { pr: PullRequest }) {
  const inbox = useInbox();
  const setPinned = rpc.setPinned.useMutation();
  const pinned = inbox.data?.pinned.some((item) => sameRef(item.ref, pr.ref)) ?? false;

  const toggle = () => {
    const key = rpc.inbox.queryKey();
    const previous = pluginQueryClient.getQueryData<Inbox>(key);
    const next = !pinned;
    void pluginQueryClient.cancelQueries({ queryKey: key });
    if (previous) {
      const checks = pluginQueryClient.getQueryData<Checks>(rpc.checks.queryKey({ ref: pr.ref }));
      pluginQueryClient.setQueryData<Inbox>(key, {
        ...previous,
        pinned: next
          ? [...previous.pinned, inboxEntry(pr, checks)]
          : previous.pinned.filter((item) => !sameRef(item.ref, pr.ref)),
      });
    }
    setPinned.mutate(
      { ref: pr.ref, pinned: next },
      {
        onError: () => {
          if (previous) pluginQueryClient.setQueryData(key, previous);
        },
        onSettled: () => void pluginQueryClient.invalidateQueries({ queryKey: key }),
      },
    );
  };

  return (
    <>
      <Tip label={pinned ? "Unpin from inbox" : "Pin to inbox"}>
        <Button
          variant="ghost"
          size="icon"
          className={cn(ICON_BUTTON, pinned && "text-foreground")}
          // A toggle keeps one name; `aria-pressed` says which way it is set.
          aria-label="Pin to inbox"
          aria-pressed={pinned}
          disabled={!inbox.data}
          onClick={toggle}
        >
          <Icon name="Pin" aria-hidden />
        </Button>
      </Tip>
      {setPinned.isError ? (
        <span
          role="alert"
          title={errorText(setPinned.error)}
          className="text-[11px] whitespace-nowrap text-destructive-text"
        >
          Could not {setPinned.variables?.pinned ? "pin" : "unpin"}
          <span className="sr-only">: {errorText(setPinned.error)}</span>
        </span>
      ) : null}
    </>
  );
}
