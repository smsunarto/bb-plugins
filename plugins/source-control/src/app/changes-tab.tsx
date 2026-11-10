/**
 * The thread's Changes tab (board C): the thread's Change, painted from the
 * last snapshot at once, then from the keyed read. Loading reserves the
 * ready layout; offline keeps the last read with what is wrong; a failed
 * first read says what broke and stops.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useTabVisible as useTabVisible,
} from "@get-bb/plugin-sdk/app";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  describeProblem,
  forgeIsBehind,
  readAgo,
  tabView,
  type CheckoutChange,
  type Facet,
  type ForgeValue,
  type LocalValue,
  type Problem,
  type ThreadChange,
} from "../core/change.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";

export function ChangesTab({ threadId }: { threadId: string }) {
  const visible = useTabVisible();
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys: [threadId],
    enabled: visible,
  });
  const live = query.data?.[threadId];
  const snapshot = useMemo(() => readSnapshot(threadId), [threadId]);
  useEffect(() => {
    if (live) writeSnapshot(threadId, live);
  }, [threadId, live]);
  // A row from the read wins; a pending one is no better than the snapshot.
  const row = live && live.state !== "pending" ? live : (snapshot ?? live);
  return <ChangesView threadId={threadId} row={row} />;
}

const ChangesView = memo(function ChangesView({
  threadId,
  row,
}: {
  threadId: string;
  row: ThreadChange | undefined;
}) {
  const retry = useRpcMutation({ contract: sourceControlContract, method: "refreshThread" });
  const onRetry = () => void retry.mutate({ threadId }).catch(() => undefined);
  const view = tabView(row);
  const repo = row?.state === "checkout" ? repoName(row) : null;
  const now = useNow();
  return (
    <div
      data-bb-plugin="source-control"
      data-testid="sc-changes"
      className="flex h-full min-h-0 flex-col overflow-auto bg-background p-3 @container"
    >
      <section className="flex min-w-0 flex-col rounded-[10px] border border-border-hairline bg-background">
        <header className="flex min-w-0 items-center gap-2 border-b border-border-hairline px-5 py-3">
          <span className="text-[13px] leading-5 font-semibold text-foreground">Workspace</span>
          {repo ? (
            <span className="min-w-0 truncate font-mono text-[12px] leading-5 text-muted-foreground">
              {repo}
            </span>
          ) : null}
          <span className="grow" />
          <span
            className="shrink-0 text-[12px] leading-5 text-muted-foreground"
            data-testid="sc-read-state"
          >
            {view.kind === "loading" || retry.isPending
              ? "Reading…"
              : view.kind === "ready"
                ? readAgo(view.readAt, now)
                : null}
          </span>
        </header>
        {view.kind === "loading" ? <LoadingBody /> : null}
        {view.kind === "none" ? (
          <p className="px-5 py-8 text-[13px] leading-5 text-muted-foreground">{view.reason}</p>
        ) : null}
        {view.kind === "failed" ? (
          <FailedBody problem={view.problem} onRetry={onRetry} retrying={retry.isPending} />
        ) : null}
        {view.kind === "ready" && row?.state === "checkout" ? (
          <>
            {view.stale ? (
              <StaleBanner problem={view.stale} onRetry={onRetry} retrying={retry.isPending} />
            ) : null}
            <ReadyBody
              local={view.local}
              forge={row.forge}
              offline={view.stale?.kind === "host-offline"}
            />
          </>
        ) : null}
      </section>
    </div>
  );
});

function repoName(row: CheckoutChange): string {
  const github = row.local.read?.value.github;
  if (github) return github.repo.name;
  return row.placement.path.split(/[\\/]/).findLast(Boolean) ?? row.placement.path;
}

/** The current time, ticking each minute so "Read N min ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Bar({ className }: { className: string }) {
  return <div className={`shrink-0 rounded-[4px] bg-surface-raised ${className}`} />;
}

function LoadingBody() {
  return (
    <div
      data-testid="sc-loading"
      aria-busy="true"
      aria-label="Reading this checkout"
      className="flex flex-col"
    >
      <div className="flex flex-col gap-3 border-b border-border-hairline p-5">
        <Bar className="h-2.5 w-18" />
        <div className="flex items-center gap-2">
          <Bar className="h-6 w-16 rounded-full" />
          <Bar className="h-5 max-w-full w-57.5" />
        </div>
        <Bar className="h-2.5 max-w-full w-50" />
        <div className="flex flex-col gap-3 rounded-[8px] border border-border-hairline p-3">
          <Bar className="h-2.5 w-30" />
          <div className="flex items-center gap-2">
            <Bar className="size-4" />
            <Bar className="h-2.5 max-w-full w-52.5" />
          </div>
          <div className="flex items-center gap-2">
            <Bar className="size-4" />
            <Bar className="h-2.5 max-w-full w-42.5" />
          </div>
        </div>
      </div>
    </div>
  );
}

function TextButton({
  children,
  onClick,
  disabled,
  strong,
}: {
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 shrink-0 items-center rounded-[6px] px-2 text-[13px] leading-4 text-foreground hover:bg-surface-raised disabled:opacity-60 ${strong ? "font-semibold" : ""}`}
    >
      {children}
    </button>
  );
}

function StaleBanner({
  problem,
  onRetry,
  retrying,
}: {
  problem: Problem;
  onRetry(): void;
  retrying: boolean;
}) {
  return (
    <output
      data-testid="sc-stale"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-hairline bg-surface-recessed px-5 py-3"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        {describeProblem(problem)} This is what bb last read.
      </span>
      <TextButton onClick={onRetry} disabled={retrying} strong>
        {retrying ? "Trying…" : "Try again"}
      </TextButton>
    </output>
  );
}

function FailedBody({
  problem,
  onRetry,
  retrying,
}: {
  problem: Problem;
  onRetry(): void;
  retrying: boolean;
}) {
  const detail = "detail" in problem ? problem.detail : null;
  return (
    <div data-testid="sc-failed" role="alert" className="flex flex-col gap-3 px-5 py-8">
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
        <span className="text-[14px] leading-5 font-semibold text-foreground">
          Couldn't read this checkout
        </span>
      </div>
      <p className="text-[13px] leading-5 text-muted-foreground">{describeProblem(problem)}</p>
      {detail ? (
        <p className="font-mono text-[12px] leading-5 break-words text-muted-foreground">
          {detail}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <TextButton onClick={onRetry} disabled={retrying}>
          {retrying ? "Trying…" : "Try again"}
        </TextButton>
      </div>
    </div>
  );
}

const PR_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;

function PullRequestChip({ forge }: { forge: ForgeValue | undefined }) {
  const label =
    forge === undefined
      ? "Unknown"
      : forge === null
        ? "No PR"
        : forge.isDraft && forge.state === "open"
          ? "Draft"
          : PR_LABEL[forge.state];
  return (
    <span
      data-testid="sc-pr-chip"
      className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-surface-raised px-2 text-[12px] leading-4 font-semibold text-foreground"
    >
      {label}
    </span>
  );
}

function forgeLine(forge: Facet<ForgeValue>, local: LocalValue): string {
  const pr = forge.read?.value;
  if (forge.problem) return describeProblem(forge.problem);
  if (pr === undefined)
    return local.github
      ? "Reading the pull request…"
      : "No GitHub remote; this Change is local to its checkout.";
  if (pr === null) return "No pull request for this branch yet.";
  const checks =
    pr.checks.failed > 0
      ? `${pr.checks.failed} checks failing`
      : pr.checks.pending > 0
        ? `${pr.checks.pending} checks running`
        : pr.checks.passed > 0
          ? "checks passing"
          : "no checks";
  const behind = forgeIsBehind(local, pr) ? " · GitHub has an older head" : "";
  return `#${pr.number} · ${checks}${behind}`;
}

function localLine(local: LocalValue): string {
  const parts: string[] = [];
  const uncommitted = local.uncommitted.length + local.moreUncommitted;
  parts.push(uncommitted === 0 ? "No uncommitted changes" : `${uncommitted} uncommitted`);
  if (local.conflicted > 0) parts.push(`${local.conflicted} conflicted`);
  if (!local.upstream) parts.push("not pushed");
  else {
    if (local.upstream.ahead > 0) parts.push(`${local.upstream.ahead} to push`);
    if (local.upstream.behind > 0) parts.push(`${local.upstream.behind} to pull`);
    if (local.upstream.ahead === 0 && local.upstream.behind === 0) parts.push("pushed");
  }
  return parts.join(" · ");
}

function ReadyBody({
  local,
  forge,
  offline,
}: {
  local: LocalValue;
  forge: Facet<ForgeValue>;
  offline: boolean;
}) {
  const pr = forge.read?.value;
  return (
    <div data-testid="sc-ready" className="flex min-w-0 flex-col gap-3 p-5">
      <span className="text-[11px] leading-4 tracking-[0.06em] text-muted-foreground uppercase">
        This thread
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <PullRequestChip forge={pr} />
        <span
          className="min-w-0 truncate text-[15px] leading-6 font-semibold text-foreground"
          data-testid="sc-title"
        >
          {pr ? pr.title : local.branch}
        </span>
      </div>
      <span
        className="text-[12px] leading-4 break-words text-muted-foreground"
        data-testid="sc-forge-line"
      >
        {forgeLine(forge, local)}
      </span>
      <span
        className="text-[12px] leading-4 break-words text-muted-foreground"
        data-testid="sc-local-line"
      >
        <span className="font-mono">{local.branch}</span> · {localLine(local)}
      </span>
      {local.commits.length > 0 ? (
        <ol className="flex min-w-0 flex-col gap-1 rounded-[8px] border border-border-hairline p-3">
          {local.commits.slice(0, 5).map((commit) => (
            <li key={commit.id} className="flex min-w-0 items-center gap-2 text-[12px] leading-4">
              <span className="shrink-0 font-mono text-muted-foreground">
                {commit.id.slice(0, 7)}
              </span>
              <span className="min-w-0 truncate text-foreground">{commit.subject}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {offline ? (
        <span className="text-[12px] leading-4 text-muted-foreground">
          Commit and push need the host. Pull request state still comes from GitHub.
        </span>
      ) : null}
    </div>
  );
}
