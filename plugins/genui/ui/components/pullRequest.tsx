// PullRequest: the branch's pull request as BB knows it (project_pull_request):
// number and title linking to it, state, base ← head, checks, review,
// mergeability and BB's attention reason. Read-only. Live: it polls, with
// backoff, only while visible and while checks run or mergeability is
// being computed.
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ATTENTION_LABEL,
  checkCounts,
  MERGEABILITY_LABEL,
  PR_STATE_LABEL,
  pullRequestSettling,
  REVIEW_LABEL,
  relativeTime,
  type ChecksState,
  type MergeabilityState,
  type PullRequestAttention,
  type PullRequestInfo,
  type PullRequestResult,
  type PullRequestState,
  type ReviewState,
} from "../../core/project";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { TONE_DOT, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { FOCUS_RING } from "./inputs";
import { EXACT_TIME, FailureLine, Freshness, NeedsThread, Panel, QuietLine, useNow, useProjectQuery, useVisible } from "./projectKit";

export const STATE_TONE: Record<PullRequestState, Tone> = { open: "good", draft: "neutral", merged: "info", closed: "bad" };
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

export function PullRequest(_: { props: Props }) {
  const { threadId } = useUiRuntime();
  if (threadId === null) {
    return (
      <NeedsThread icon="GitPullRequest">
        <span className="font-medium text-foreground">PullRequest</span> needs a thread: in a reply it shows the pull request of that
        thread's branch.
      </NeedsThread>
    );
  }
  return <PullRequestPanel threadId={threadId} />;
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
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name={pr === null ? "GitPullRequest" : STATE_ICON[pr.state]} aria-hidden className={cn("size-3.5 shrink-0", pr !== null && TONE_TEXT[STATE_TONE[pr.state]])} />
              <span className="font-medium text-foreground">Pull request</span>
            </span>
            {pr === null ? null : (
              <span className={cn("rounded-full px-2 py-px text-[11px] font-medium leading-4", TONE_PILL[STATE_TONE[pr.state]])}>
                {PR_STATE_LABEL[pr.state]}
              </span>
            )}
            {answer?.ok ? (
              <Freshness at={answer.fetchedAt} stored={false} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
            ) : null}
          </>
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
          <Fact label="Merge" tone={STATE_TONE[pr.state]} value={PR_STATE_LABEL[pr.state]} detail="" />
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

function Fact({ label, tone, value, detail, pulse = false }: { label: string; tone: Tone; value: string; detail: string; pulse?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 leading-5 text-foreground">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], pulse && "animate-pulse motion-reduce:animate-none")} />
        <span className="min-w-0 truncate font-medium">{value}</span>
        {detail === "" ? null : <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
      </dd>
    </div>
  );
}
