// PullRequest: the branch's pull request as BB knows it (project_pull_request):
// number and title linking to it, state, base ← head, checks, review,
// mergeability and BB's attention reason. PullRequest(refs) shows the pull
// requests named instead (project_pull_requests, read through Source
// Control): one as the same card, several as rows, each repository read on
// its own so a slow or unreadable one holds up only its rows. Read-only.
// Live: it polls, with backoff, only while visible and while checks run or
// mergeability is being computed.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ATTENTION_LABEL,
  checkCounts,
  MERGEABILITY_LABEL,
  parsePullRequestRefs,
  PR_STATE_LABEL,
  pullRequestRefKey,
  pullRequestRepoKey,
  PULL_REQUESTS_SHOWN,
  pullRequestSettling,
  REVIEW_LABEL,
  relativeTime,
  type ChecksState,
  type MergeabilityState,
  type PullRequestAttention,
  type PullRequestInfo,
  type PullRequestRead,
  type PullRequestRef,
  type PullRequestResult,
  type PullRequestsResult,
  type PullRequestState,
  type ReviewState,
} from "../../core/project";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { TONE_DOT, TONE_PILL, type Props, type Tone } from "../values";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import {
  EXACT_TIME,
  FailureLine,
  Freshness,
  ICON_BUTTON,
  LoadingRows,
  NeedsThread,
  Panel,
  QuietLine,
  useNow,
  useProjectQuery,
  useVisible,
  type Query,
} from "./projectKit";

export const STATE_TONE: Record<PullRequestState, Tone> = { open: "good", draft: "neutral", merged: "info", closed: "bad" };
// A pull request's state wears Source Control's colours (its PR_LOOK and state icons), so a
// pull request looks the same in both plugins. Merged is the theme's --pr-merged purple.
// Class strings stay literal so Tailwind finds them.
export const STATE_TEXT: Record<PullRequestState, string> = {
  open: "text-success",
  draft: "text-[var(--tertiary-foreground)]",
  merged: "text-[var(--pr-merged,var(--color-timeline-accent,var(--primary)))]",
  closed: "text-destructive",
};
const STATE_DOT: Record<PullRequestState, string> = {
  open: "bg-success",
  draft: "bg-[var(--tertiary-foreground)]",
  merged: "bg-[var(--pr-merged,var(--color-timeline-accent,var(--primary)))]",
  closed: "bg-destructive",
};
const STATE_PILL: Record<PullRequestState, string> = {
  open: "bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-success",
  draft: "bg-surface-raised text-muted-foreground",
  merged: "bg-[color-mix(in_oklab,var(--pr-merged,var(--color-timeline-accent,var(--primary)))_14%,transparent)] text-[var(--pr-merged,var(--color-timeline-accent,var(--primary)))]",
  closed: "bg-[color-mix(in_oklab,var(--destructive)_14%,transparent)] text-destructive",
};
export const STATE_ICON: Record<PullRequestState, string> = {
  open: "GitPullRequest",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};
export const CHECKS_TONE: Record<ChecksState, Tone> = { passing: "good", failing: "bad", pending: "warn", no_checks: "neutral", unknown: "neutral" };
/** The checks' state under the "Checks" caption (core's CHECKS_LABEL repeats the word). */
const CHECKS_VALUE: Record<ChecksState, string> = { passing: "Passing", failing: "Failing", pending: "Running", no_checks: "None", unknown: "Unknown" };
const REVIEW_TONE: Record<ReviewState, Tone> = {
  approved: "good",
  changes_requested: "bad",
  review_requested: "warn",
  review_required: "warn",
  none: "neutral",
};
const MERGE_TONE: Record<MergeabilityState, Tone> = { mergeable: "good", conflicts: "bad", blocked: "warn", draft: "neutral", unknown: "neutral" };
const ATTENTION_TONE: Record<PullRequestAttention, Tone> = {
  blocked: "warn",
  changes_requested: "bad",
  checks_failed: "bad",
  checks_pending: "warn",
  closed: "neutral",
  conflicts: "bad",
  draft: "neutral",
  merged: "info",
  none: "neutral",
  queued: "info",
  ready_to_merge: "good",
  review_requested: "warn",
};

export function PullRequest({ props }: { props: Props }) {
  const { threadId } = useUiRuntime();
  // While the reply streams, the list is empty until its first ref is complete.
  if (Array.isArray(props.refs) && props.refs.length === 0) return <PendingList />;
  const refs = parsePullRequestRefs(props.refs);
  if (!refs.ok) return <ErrorLine message={refs.error} />;
  if (threadId === null) {
    return (
      <NeedsThread icon="GitPullRequest">
        <span className="font-medium text-foreground">PullRequest</span> needs a thread: in a reply it shows
        {refs.value === null ? " the pull request of that thread's branch." : " live state of the pull requests named."}
      </NeedsThread>
    );
  }
  if (refs.value === null) return <PullRequestPanel threadId={threadId} />;
  if (refs.value.length === 1) return <NamedPullRequestPanel threadId={threadId} prRef={refs.value[0]!} />;
  return <PullRequestList threadId={threadId} refs={refs.value} />;
}

function PullRequestPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { query, refresh } = useProjectQuery<PullRequestResult>(
    `pull-request\0${threadId}`,
    () => rpc.call("project_pull_request", { threadId }),
    { visible, live: (answer) => answer.ok && answer.pullRequest !== null && pullRequestSettling(answer.pullRequest) },
  );
  const now = useNow();
  const answer = query.status === "ready" ? query.answer : null;
  const pr = answer?.ok ? answer.pullRequest : null;
  return (
    <div ref={ref} className="min-w-0">
      <Panel
        label="Pull request"
        header={
          <PullRequestHeader pr={pr}>
            {answer?.ok ? (
              <Freshness at={answer.fetchedAt} stored={false} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
            ) : null}
          </PullRequestHeader>
        }
      >
        {answer === null ? (
          <PullRequestSkeleton />
        ) : !answer.ok ? (
          <FailureLine failure={answer} />
        ) : pr === null ? (
          <QuietLine icon="GitPullRequest" className="px-3 py-2.5">
            {answer.branch === null ? "This checkout has no branch, so no pull request." : (
              <>
                No pull request for <span className="font-mono text-foreground">{answer.branch}</span>.
              </>
            )}
          </QuietLine>
        ) : (
          <PullRequestBody pr={pr} now={now} />
        )}
      </Panel>
    </div>
  );
}

/** The card's header: the state's icon, "Pull request" and its state, then `children` (freshness). */
function PullRequestHeader({ pr, children }: { pr: PullRequestInfo | null; children: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name={pr === null ? "GitPullRequest" : STATE_ICON[pr.state]} aria-hidden className={cn("size-3.5 shrink-0", pr !== null && STATE_TEXT[pr.state])} />
        <span className="font-medium text-foreground">Pull request</span>
      </span>
      {pr === null ? null : (
        <span className={cn("rounded-full px-2 py-px text-[11px] font-medium leading-4", STATE_PILL[pr.state])}>
          {PR_STATE_LABEL[pr.state]}
        </span>
      )}
      {children}
    </>
  );
}

/** Pull requests by reference, read for one repository: `refs` all name it. */
function usePullRequestsQuery(threadId: string, refs: readonly PullRequestRef[], visible: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  return useProjectQuery<PullRequestsResult>(
    `pull-requests\0${threadId}\0${refs.map(pullRequestRefKey).join(" ")}`,
    (refresh) => rpc.call("project_pull_requests", { threadId, refs: refs.map(({ owner, repo, number }) => ({ owner, repo, number })), refresh }),
    { visible, live: (answer) => answer.ok && answer.rows.some(({ read }) => read.ok && read.settling) },
  );
}

/** PullRequest(["owner/repo#N"]): that pull request as the branch's card shows it. */
function NamedPullRequestPanel({ threadId, prRef }: { threadId: string; prRef: PullRequestRef }) {
  const refs = useMemo(() => [prRef], [prRef]);
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { query, refresh } = usePullRequestsQuery(threadId, refs, visible);
  const now = useNow();
  const answer = query.status === "ready" ? query.answer : null;
  const read = answer?.ok ? (answer.rows[0]?.read ?? null) : null;
  const pr = read?.ok ? read.pullRequest : null;
  return (
    <div ref={ref} className="min-w-0">
      <Panel
        label="Pull request"
        header={
          <PullRequestHeader pr={pr}>
            {answer?.ok ? (
              <Freshness at={answer.fetchedAt} stored={false} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
            ) : null}
          </PullRequestHeader>
        }
      >
        {answer === null ? (
          <PullRequestSkeleton />
        ) : !answer.ok ? (
          <FailureLine failure={answer} />
        ) : pr === null ? (
          <QuietLine icon="AlertCircle" className="px-3 py-2.5">
            <span className="font-mono text-foreground">{pullRequestRefKey(prRef)}</span>: {read === null || read.ok ? "no answer" : read.message}
          </QuietLine>
        ) : (
          <PullRequestBody pr={pr} now={now} />
        )}
      </Panel>
    </div>
  );
}

/** Each repository's refs, in the order the repositories first appear. */
function byRepository(refs: readonly PullRequestRef[]): readonly (readonly PullRequestRef[])[] {
  const groups = new Map<string, PullRequestRef[]>();
  for (const ref of refs) {
    const key = pullRequestRepoKey(ref);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [ref]);
    else group.push(ref);
  }
  return [...groups.values()];
}

/** PullRequest(refs) with several refs: one row each, in the order named, the first PULL_REQUESTS_SHOWN read. */
function PullRequestList({ threadId, refs }: { threadId: string; refs: readonly PullRequestRef[] }) {
  const signature = refs.map(pullRequestRefKey).join(" ");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` is what the refs say.
  const shown = useMemo(() => refs.slice(0, PULL_REQUESTS_SHOWN), [signature]);
  const groups = useMemo(() => byRepository(shown), [shown]);
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [reads, setReads] = useState<ReadonlyMap<string, PullRequestRead>>(() => new Map());
  const [refreshes, setRefreshes] = useState(0);
  const [refreshing, setRefreshing] = useState(0);
  const onAnswer = useCallback((rows: ReadonlyMap<string, PullRequestRead>) => {
    setReads((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, read] of rows) {
        if (next.get(key) !== read) {
          next.set(key, read);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);
  const onRefreshing = useCallback((delta: number) => setRefreshing((count) => count + delta), []);
  const more = refs.length - shown.length;
  return (
    <div ref={ref} className="min-w-0">
      {groups.map((group) => (
        <RepositoryRead
          key={group.map(pullRequestRefKey).join(" ")}
          threadId={threadId}
          refs={group}
          visible={visible}
          refreshes={refreshes}
          onAnswer={onAnswer}
          onRefreshing={onRefreshing}
        />
      ))}
      <Panel
        label="Pull requests"
        header={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name="GitPullRequest" aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">Pull requests</span>
              <span className="tabular-nums">{refs.length}</span>
            </span>
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh"
              disabled={refreshing > 0}
              onClick={() => setRefreshes((count) => count + 1)}
              className={cn(ICON_BUTTON, "ml-auto")}
            >
              <Icon name="RotateCcw" aria-hidden className={cn("size-3.5", refreshing > 0 && "animate-spin motion-reduce:animate-none")} />
            </button>
          </>
        }
      >
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {shown.map((each) => (
            <PullRequestRowItem key={pullRequestRefKey(each)} prRef={each} read={reads.get(pullRequestRefKey(each)) ?? null} />
          ))}
        </ul>
        {more > 0 ? (
          <QuietLine className="border-t border-border/60 px-3 py-2">
            +{more} more not shown
          </QuietLine>
        ) : null}
      </Panel>
    </div>
  );
}

/** A list whose refs are still streaming in. */
function PendingList() {
  return (
    <Panel
      label="Pull requests"
      header={
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon name="GitPullRequest" aria-hidden className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground">Pull requests</span>
        </span>
      }
    >
      <LoadingRows label="Loading pull requests" rows={2} />
    </Panel>
  );
}

/**
 * One repository's read: renders nothing, hands its rows to the list as they
 * arrive. Polls while the list is visible and one of its pull requests is
 * settling, as the card does.
 */
function RepositoryRead({
  threadId,
  refs,
  visible,
  refreshes,
  onAnswer,
  onRefreshing,
}: {
  threadId: string;
  refs: readonly PullRequestRef[];
  visible: boolean;
  refreshes: number;
  onAnswer: (rows: ReadonlyMap<string, PullRequestRead>) => void;
  onRefreshing: (delta: number) => void;
}) {
  const { query, refresh } = usePullRequestsQuery(threadId, refs, visible);
  useEffect(() => {
    const rows = answerRows(query, refs);
    if (rows !== null) onAnswer(rows);
  }, [query, refs, onAnswer]);
  useEffect(() => {
    if (refreshes === 0) return;
    onRefreshing(1);
    void refresh().finally(() => onRefreshing(-1));
  }, [refreshes, refresh, onRefreshing]);
  return null;
}

/** Each ref's read once the repository answered; a failure of the whole read is each ref's. */
function answerRows(query: Query<PullRequestsResult>, refs: readonly PullRequestRef[]): ReadonlyMap<string, PullRequestRead> | null {
  if (query.status !== "ready") return null;
  const answer = query.answer;
  if (!answer.ok) {
    const read: PullRequestRead = { ok: false, reason: "unavailable", message: answer.message };
    return new Map(refs.map((each) => [pullRequestRefKey(each), read]));
  }
  return new Map(answer.rows.map((row) => [pullRequestRefKey(row.ref), row.read]));
}

/** One row: state, `owner/repo #N` and title linking to it, then checks, review and what it waits for. */
function PullRequestRowItem({ prRef, read }: { prRef: PullRequestRef; read: PullRequestRead | null }) {
  const name = (
    <span className="font-normal text-muted-foreground">
      {prRef.owner}/{prRef.repo} #{prRef.number}
    </span>
  );
  if (read === null) {
    return (
      <li className="flex min-w-0 flex-col gap-1 border-t border-border/60 px-3 py-2 first:border-t-0" aria-busy="true">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <span className={cn("size-3.5 shrink-0", BAR)} />
          <span className="min-w-0 truncate text-[13px]">{name}</span>
          <span className={cn("h-3 w-2/5", BAR)} />
        </span>
        <span className="flex h-5 items-center pl-[22px]">
          <span className={cn("h-3 w-1/2", BAR)} />
        </span>
      </li>
    );
  }
  if (!read.ok) {
    return (
      <li className="flex min-w-0 flex-col gap-1 border-t border-border/60 px-3 py-2 first:border-t-0">
        <span className="flex h-5 min-w-0 items-center gap-2 text-[13px]">
          <Icon name="AlertCircle" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{name}</span>
        </span>
        <span className="min-w-0 pl-[22px] text-[11.5px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{read.message}</span>
      </li>
    );
  }
  const pr = read.pullRequest;
  const attention = ATTENTION_LABEL[pr.attention];
  const final = pr.state === "merged" || pr.state === "closed";
  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-border/60 px-3 py-2 first:border-t-0">
      <span className="flex min-h-5 min-w-0 items-center gap-2">
        <Icon name={STATE_ICON[pr.state]} aria-hidden className={cn("size-3.5 shrink-0", STATE_TEXT[pr.state])} />
        <UrlLink
          href={pr.url}
          title={`${pullRequestRefKey(prRef)}: ${pr.title}`}
          className={cn("min-w-0 truncate rounded-sm text-[13px] font-medium leading-5 text-foreground no-underline hover:underline hover:underline-offset-2", FOCUS_RING)}
        >
          {name} {pr.title}
        </UrlLink>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-[22px] text-[11.5px] leading-5 text-muted-foreground">
        <span className={cn(CHIP, STATE_PILL[pr.state])}>{PR_STATE_LABEL[pr.state]}</span>
        {final ? null : <ChecksChip checks={pr.checks} />}
        <RowFact tone={REVIEW_TONE[pr.review.state]} label={REVIEW_LABEL[pr.review.state]} detail="" />
        {final ? null : attention !== null ? (
          <span className={cn("rounded-sm px-1.5 text-[11px] font-medium leading-4", TONE_PILL[ATTENTION_TONE[pr.attention]])}>{attention}</span>
        ) : (
          <RowFact tone={MERGE_TONE[pr.mergeability]} label={MERGEABILITY_LABEL[pr.mergeability]} detail={pr.inMergeQueue ? "in merge queue" : ""} />
        )}
      </span>
    </li>
  );
}

// Source Control's chip (workspace-lane.tsx CHIP and ChecksChip), so a pull request's
// checks read the same in both plugins: failing, running, or passed, on open ones only.
const CHIP = "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] leading-none font-medium whitespace-nowrap";

function ChecksChip({ checks }: { checks: PullRequestInfo["checks"] }) {
  if (checks.failed > 0) return <span className={cn(CHIP, "bg-[color-mix(in_oklab,var(--destructive)_14%,transparent)] text-destructive")}>{checks.failed} Failing</span>;
  if (checks.pending > 0)
    return (
      <span className={cn(CHIP, "bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-warning")}>
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {checks.pending} Running
      </span>
    );
  if (checks.passed > 0)
    return (
      <span className={cn(CHIP, STATE_PILL.open)}>
        <Icon name="Check" aria-hidden className="size-3" />
        Passed
      </span>
    );
  return null;
}

function RowFact({ tone, label, detail, pulse = false }: { tone: Tone; label: string; detail: string; pulse?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], pulse && "animate-pulse motion-reduce:animate-none")} />
      <span className="text-foreground">{label}</span>
      {detail === "" ? null : <span className="truncate">{detail}</span>}
    </span>
  );
}

function PullRequestBody({ pr, now }: { pr: PullRequestInfo; now: number }) {
  const attention = ATTENTION_LABEL[pr.attention];
  const counts = checkCounts(pr.checks);
  return (
    <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <UrlLink
          href={pr.url}
          title={`Open #${pr.number} on ${hostOf(pr.url)}`}
          className={cn(
            "group/link w-fit max-w-full rounded-sm text-[15px] font-semibold leading-6 tracking-[-0.01em] text-foreground no-underline [overflow-wrap:anywhere] hover:underline hover:underline-offset-2",
            FOCUS_RING,
          )}
        >
          <span className="font-normal text-muted-foreground">#{pr.number}</span> {pr.title}
          <Icon name="ExternalLink" aria-hidden className="ml-1 inline size-3.5 align-[-2px] text-muted-foreground group-hover/link:text-foreground" />
        </UrlLink>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-5 text-muted-foreground">
          <span className="sr-only">Into</span>
          <span className="min-w-0 truncate rounded-sm bg-surface-recessed px-1.5 font-mono" title={pr.baseRef}>
            {pr.baseRef}
          </span>
          <span aria-hidden>←</span>
          <span className="sr-only">from</span>
          <span className="min-w-0 truncate rounded-sm bg-surface-recessed px-1.5 font-mono" title={pr.headRef}>
            {pr.headRef}
          </span>
          {pr.updatedAt === null ? null : (
            <time dateTime={new Date(pr.updatedAt).toISOString()} title={`Updated on GitHub ${EXACT_TIME.format(pr.updatedAt)}`} className="tabular-nums">
              updated {relativeTime(pr.updatedAt, now)}
            </time>
          )}
        </span>
      </div>
      {attention === null ? null : (
        <div className={cn("flex w-fit max-w-full items-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium leading-5", TONE_PILL[ATTENTION_TONE[pr.attention]])}>
          <span className="sr-only">Needs: </span>
          {attention}
          {pr.autoMerge ? <span className="font-normal opacity-80">· auto-merge on</span> : null}
        </div>
      )}
      <dl className="m-0 grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-xs min-[420px]:grid-cols-3">
        <Fact label="Checks" tone={CHECKS_TONE[pr.checks.state]} value={CHECKS_VALUE[pr.checks.state]} detail={counts} pulse={pr.checks.state === "pending"} />
        <Fact
          label="Review"
          tone={REVIEW_TONE[pr.review.state]}
          value={REVIEW_LABEL[pr.review.state]}
          detail={pr.review.requests > 0 ? `${pr.review.requests} requested` : ""}
        />
        {pr.state === "merged" || pr.state === "closed" ? (
          // Mergeability means nothing once the pull request is merged or closed.
          <Fact label="Merge" tone={STATE_TONE[pr.state]} dot={STATE_DOT[pr.state]} value={PR_STATE_LABEL[pr.state]} detail="" />
        ) : (
          <Fact label="Merge" tone={MERGE_TONE[pr.mergeability]} value={MERGEABILITY_LABEL[pr.mergeability]} detail={pr.inMergeQueue ? "in merge queue" : ""} />
        )}
      </dl>
    </div>
  );
}

const BAR = "animate-pulse rounded-sm bg-muted motion-reduce:animate-none";

/**
 * The body's layout while BB answers, so the panel opens at about its final
 * height instead of growing by a title, a refs line and three facts once the
 * answer comes. A phone wraps most titles onto two lines.
 */
function PullRequestSkeleton() {
  return (
    <div role="status" aria-label="Loading the pull request" className="flex min-w-0 flex-col gap-3 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex h-12 flex-col justify-center gap-3 min-[420px]:h-6">
          <div className={cn("h-3.5 w-11/12", BAR)} />
          <div className={cn("h-3.5 w-1/2 min-[420px]:hidden", BAR)} />
        </div>
        <div className="flex h-5 items-center">
          <div className={cn("h-3 w-1/2", BAR)} />
        </div>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 min-[420px]:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex min-w-0 flex-col gap-0.5">
            <div className="flex h-4 items-center">
              <div className={cn("h-2.5 w-12", BAR)} />
            </div>
            <div className="flex h-5 items-center">
              <div className={cn("h-3 w-20", BAR)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the web";
  }
}

function Fact({ label, tone, dot, value, detail, pulse = false }: { label: string; tone: Tone; dot?: string; value: string; detail: string; pulse?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 leading-5 text-foreground">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot ?? TONE_DOT[tone], pulse && "animate-pulse motion-reduce:animate-none")} />
        <span className="min-w-0 truncate font-medium">{value}</span>
        {detail === "" ? null : <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
      </dd>
    </div>
  );
}
