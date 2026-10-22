import { UrlLink, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { useState } from "react";
import { prKey, prSubPath, sameAccount, sameRef } from "../shared/schema.ts";
import type { Checks, Inbox, InboxPr, PrRef, PrTab, PullRequest } from "../shared/schema.ts";
import { PrReview } from "./changes.tsx";
import { useChecks } from "./checks.tsx";
import { ReviewWithBbButton } from "./bb-review.tsx";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS } from "./components/ui/coarse-pointer-sizing.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { PANEL_PATH, plural } from "./format.ts";
import { useInbox } from "./inbox.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, Tip, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { DraftSyncNotice, useDraftPreview } from "./draft-sync.tsx";
import { SyncState, pageSync, useReconcile } from "./sync-state.tsx";
import type { SyncQuery } from "./sync-state.tsx";
import { AccountAvatar, Avatar, PrStateBadge, Timestamp } from "./status.tsx";
import { SubmitReviewButton } from "./submit-review.tsx";
import { PrOverview } from "./summary.tsx";

/** How often an open pull request is read again, for new pushes, reviews, and comments. */
const PR_REFRESH_MS = 60_000;

const ICON_BUTTON = cn(COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS, "text-muted-foreground");

function useBackToInbox(): () => void {
  const navigate = useBbNavigate();
  return () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
}

/** One pull request's details, checks, and diffs in a single review surface. */
export function PrView({ prRef, account, tab }: { prRef: PrRef; account: string; tab: PrTab }) {
  const pullRequest = rpc.pullRequest.useQuery(
    { account, ref: prRef },
    { staleTime: 15_000, refetchInterval: PR_REFRESH_MS },
  );
  const back = useBackToInbox();
  useReconcile();
  const pr = useDraftPreview(pullRequest.data);
  if (!pr) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <span className="truncate text-muted-foreground">{prKey(prRef)}</span>
          {/* Another account may see what this one cannot. */}
          {pullRequest.isError ? <AccountSwitch prRef={prRef} account={account} tab={tab} /> : null}
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
  return (
    <>
      <DraftSyncNotice pr={pr} />
      <Loaded pr={pr} tab={tab} pullRequest={pullRequest} />
    </>
  );
}

function Loaded({ pr, tab, pullRequest }: { pr: PullRequest; tab: PrTab; pullRequest: SyncQuery }) {
  const checks = useChecks(pr);
  // All three reads contribute to the page's freshness and refresh action.
  const files = rpc.changedFiles.useQuery(
    { account: pr.account, ref: pr.ref },
    { staleTime: 30_000 },
  );
  const sync = pageSync(pullRequest, [checks, files]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border bg-background px-3 py-2.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-1">
            <h1 className="min-w-0 text-sm leading-snug font-semibold [overflow-wrap:anywhere]">
              {pr.title}{" "}
              <span className="font-normal text-muted-foreground tabular-nums">
                #{pr.ref.number}
              </span>
            </h1>
          </div>
          <Toolbar pr={pr} />
        </div>
        <Meta pr={pr} tab={tab} sync={sync} />
      </header>
      <PrReview pr={pr} section={tab} overview={<PrOverview pr={pr} />} />
    </div>
  );
}

/** The PR's state, branches, author, and size, with how fresh the copy is at the end. */
function Meta({ pr, tab, sync }: { pr: PullRequest; tab: PrTab; sync: SyncQuery }) {
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
      <span className="ms-auto flex min-w-0 items-center gap-2.5">
        <SyncState query={sync} />
        <AccountSwitch prRef={pr.ref} account={pr.account} tab={tab} />
      </span>
    </div>
  );
}

/**
 * Which signed-in account the page reads and writes as, shown only when gh
 * has more than one. Drafts, viewed marks, and the review all belong to it,
 * so switching opens the same pull request as the other account.
 */
function AccountSwitch({
  prRef,
  account: acting,
  tab,
}: {
  prRef: PrRef;
  account: string;
  tab: PrTab;
}) {
  const navigate = useBbNavigate();
  const status = rpc.status.useQuery({ staleTime: 5 * 60_000 });
  const [open, setOpen] = useState(false);
  const accounts = status.data?.ok ? status.data.accounts : [];
  if (accounts.length < 2) return null;
  const others = accounts.filter((account) => !sameAccount(account, acting));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded px-1 py-0.5 hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Acting as ${acting}. Switch account`}
        >
          <AccountAvatar login={acting} className="size-3.5" />
          <span>
            as <span className="text-foreground">{acting}</span>
          </span>
          <Icon name="ChevronDown" className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileTitle="Switch account" className="w-56 p-1 text-xs">
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
          Your drafts and review belong to the account you act as.
        </p>
        {others.map((account) => (
          <button
            key={account}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(prRef, tab, account) });
            }}
          >
            <AccountAvatar login={account} className="size-4" />
            Act as <span className="font-medium">{account}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
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
      <ReviewWithBbButton pr={pr} />
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
    account: pr.account,
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
      const checks = pluginQueryClient.getQueryData<Checks>(
        rpc.checks.queryKey({ account: pr.account, ref: pr.ref }),
      );
      pluginQueryClient.setQueryData<Inbox>(key, {
        ...previous,
        pinned: next
          ? [...previous.pinned, inboxEntry(pr, checks)]
          : previous.pinned.filter((item) => !sameRef(item.ref, pr.ref)),
      });
    }
    setPinned.mutate(
      { account: pr.account, ref: pr.ref, pinned: next },
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
