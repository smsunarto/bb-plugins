// Commits: the branch's commits since the default branch, newest first, read
// from BB (project_commits) and kept per reply block like Changes. Each
// commit opens its own changes, read live (a commit never changes).
import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { parseCommitLimit, relativeTime, type CommitInfo, type CommitsResult, type CommitsView } from "../../core/project";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { formatNumber, type Props } from "../values";
import { CommitChanges } from "./changes";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import { EXACT_TIME, FailureLine, Freshness, LoadingRows, NeedsThread, Panel, QuietLine, ShowAll, useNow, useProjectQuery } from "./projectKit";

/** Commits listed before "Show all" when no limit is given. */
const COLLAPSED_COMMITS = 10;
const COLLAPSE_FROM = 14;

export function Commits({ props }: { props: Props }) {
  const { threadId, blockKey } = useUiRuntime();
  const limit = parseCommitLimit(props.limit);
  if (!limit.ok) return <ErrorLine message={limit.error} />;
  if (threadId === null) {
    return (
      <NeedsThread icon="GitBranch">
        <span className="font-medium text-foreground">Commits</span> needs a thread: in a reply it lists the commits on that thread's
        branch since the default branch.
      </NeedsThread>
    );
  }
  return <CommitsPanel threadId={threadId} blockKey={blockKey} limit={limit.value} />;
}

function CommitsPanel({ threadId, blockKey, limit }: { threadId: string; blockKey: string | null; limit: number | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { query, refresh } = useProjectQuery<CommitsResult>(`commits\0${threadId}\0${blockKey ?? ""}`, (refresh) =>
    rpc.call("project_commits", { threadId, blockKey, refresh }),
  );
  const now = useNow();
  const answer = query.status === "ready" ? query.answer : null;
  const view = answer?.ok ? answer : null;
  return (
    <Panel
      label="Commits"
      header={
        <>
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <Icon name="GitBranch" aria-hidden className="size-3.5 shrink-0" />
            {view === null ? (
              <span className="font-medium text-foreground">Commits</span>
            ) : (
              <span className="min-w-0 truncate font-mono text-[11.5px] font-medium text-foreground" title={view.branch ?? undefined}>
                {view.branch ?? (view.head === null ? "detached HEAD" : `detached ${view.head}`)}
              </span>
            )}
          </span>
          {view === null || view.onBase || view.ahead === null ? null : <Divergence view={view} />}
          {view === null ? null : (
            <Freshness at={view.takenAt} stored={view.stored} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
          )}
        </>
      }
    >
      {answer === null ? (
        <LoadingRows label="Loading commits" />
      ) : !answer.ok ? (
        <FailureLine failure={answer} />
      ) : (
        <CommitList threadId={threadId} view={answer} limit={limit} now={now} />
      )}
    </Panel>
  );
}

/** "3 ahead · 12 behind main": where the branch stands against the default branch. */
function Divergence({ view }: { view: CommitsView }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 tabular-nums" title={`Against ${view.base}`}>
      <span className="shrink-0 whitespace-nowrap">
        <span className="font-medium text-foreground">{formatNumber(view.ahead ?? 0)}</span> ahead
      </span>
      <span aria-hidden>·</span>
      <span className="shrink-0 whitespace-nowrap">
        <span className="font-medium text-foreground">{formatNumber(view.behind ?? 0)}</span> behind
      </span>
      <span className="min-w-0 truncate font-mono text-[11.5px]">{view.base}</span>
    </span>
  );
}

function emptySentence(view: CommitsView): string {
  if (view.checkout === "unborn") return `${view.branch ?? "This branch"} has no commits yet.`;
  if (view.onBase) return `This checkout is on ${view.base}, the default branch: there are no branch commits to list.`;
  if (view.ahead === null) return `BB found no merge base with ${view.base}.`;
  return `No commits since ${view.base}.`;
}

function CommitList({ threadId, view, limit, now }: { threadId: string; view: CommitsView; limit: number | null; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  if (view.commits.length === 0) return <QuietLine className="px-3 py-2.5">{emptySentence(view)}</QuietLine>;
  const allowed = limit === null ? view.commits : view.commits.slice(0, limit);
  const collapsed = limit === null && !expanded && allowed.length >= COLLAPSE_FROM;
  const shown = collapsed ? allowed.slice(0, COLLAPSED_COMMITS) : allowed;
  const total = view.ahead ?? view.commits.length;
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0">
        <ol aria-label="Commits, newest first" className="m-0 flex min-w-0 list-none flex-col p-0">
          {shown.map((commit) => (
            <CommitRow key={commit.sha} threadId={threadId} commit={commit} now={now} />
          ))}
        </ol>
        {collapsed ? <ShowAll count={allowed.length} noun="commits" onClick={() => setExpanded(true)} /> : null}
        {shown.length < total && !collapsed ? (
          <QuietLine className="border-t border-border/60 px-3 py-2">
            {formatNumber(shown.length)} of {formatNumber(total)} commits
          </QuietLine>
        ) : null}
      </div>
    </div>
  );
}

function CommitRow({ threadId, commit, now }: { threadId: string; commit: CommitInfo; now: number }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-changes`}
        aria-label={`${commit.subject}, ${commit.shortSha} by ${commit.author}, ${relativeTime(commit.authoredAt, now)}`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-start gap-2 py-2 pl-2 pr-3 text-left transition-colors duration-150 hover:bg-state-hover",
          FOCUS_RING,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="min-w-0 flex-1 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere] sm:truncate" title={commit.subject}>
            {commit.subject}
          </span>
          <span className="flex shrink-0 items-baseline gap-2 text-[11px] leading-4 text-muted-foreground">
            <span className="font-mono">{commit.shortSha}</span>
            <span className="max-w-[10rem] truncate">{commit.author}</span>
            <time dateTime={new Date(commit.authoredAt).toISOString()} title={EXACT_TIME.format(commit.authoredAt)} className="tabular-nums">
              {relativeTime(commit.authoredAt, now)}
            </time>
          </span>
        </span>
      </button>
      <div
        id={`${id}-changes`}
        role="region"
        aria-label={`Changes in ${commit.shortSha}`}
        hidden={!open}
        className={open ? "block border-t border-border/60 bg-surface-recessed/40 pl-5" : "hidden"}
      >
        {mounted ? <CommitChanges threadId={threadId} sha={commit.sha} /> : null}
      </div>
    </li>
  );
}
