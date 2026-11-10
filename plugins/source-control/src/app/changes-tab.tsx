/**
 * The thread's Source Control tab (board B): the workspace header with the
 * target's new commits and Pull, this thread's Change, the uncommitted
 * files, and each stack's branch cards. Painted from the last snapshot at
 * once, then from the keyed read. Loading reserves the ready layout; offline
 * keeps the last read with what is wrong; a failed first read says what broke.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useTabVisible as useTabVisible,
} from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  describeProblem,
  forgeIsBehind,
  readAgo,
  tabView,
  uncommittedCount,
  type Branch,
  type CheckoutChange,
  type Facet,
  type ForgeValue,
  type Problem,
  type TabView,
  type Target,
  type ThreadChange,
  type WorkspaceValue,
} from "../core/change.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { PullButton, PullStatus, WORKSPACE, useVcsActions } from "./branch-actions.tsx";
import { plural, shortId, shortRef } from "./format.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";
import { Bar, Button, SectionLabel } from "./ui.tsx";
import { StackLane, UncommittedCard } from "./workspace-lane.tsx";

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
  // Keyed by thread: writes, questions, and open commits belong to one
  // thread, so a late answer for A never lands in B's cards.
  const fromRead = live !== undefined && live.state !== "pending";
  return <ChangesView key={threadId} threadId={threadId} row={row} live={fromRead} />;
}

/** The current time, ticking so "Read N min ago" and commit ages stay true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function repoName(row: CheckoutChange): string {
  const github = row.local.read?.value.github;
  if (github) return github.repo.name;
  return row.placement.path.split(/[\\/]/).findLast(Boolean) ?? row.placement.path;
}

type Vcs = ReturnType<typeof useVcsActions>;

/**
 * The header's read state: the local facet's own age, never "now" for an old
 * read. A live, healthy read shows none: the server publishes only changes,
 * so the age of an unchanged read is the age of its last change.
 */
function readStateText(view: TabView, reading: boolean, live: boolean, now: number): string | null {
  if (view.kind === "loading" || reading) return "Reading…";
  if (view.kind !== "ready" || (live && !view.stale)) return null;
  return readAgo(view.readAt, now);
}

const ChangesView = memo(function ChangesView({
  threadId,
  row,
  live,
}: {
  threadId: string;
  row: ThreadChange | undefined;
  /** From the server's read now, not the last snapshot. */
  live: boolean;
}) {
  const refresh = useRpcMutation({ contract: sourceControlContract, method: "refreshThread" });
  const readAs = useRpcMutation({ contract: sourceControlContract, method: "setReadAs" });
  const onRetry = () => void refresh.mutate({ threadId }).catch(() => undefined);
  const onReadAs = (mode: "auto" | "git") =>
    void readAs.mutate({ threadId, readAs: mode }).catch(() => undefined);
  const vcs = useVcsActions(threadId);
  const view = tabView(row);
  const now = useNow();
  const checkout = row?.state === "checkout" ? row : null;
  const workspace = view.kind === "ready" ? view.workspace : null;
  const target = workspace?.target ?? null;

  return (
    <div
      data-bb-plugin="source-control"
      data-testid="sc-changes"
      className="@container flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      <Header
        repo={checkout ? repoName(checkout) : null}
        readState={readStateText(view, refresh.isPending, live, now)}
        target={target}
        vcs={vcs}
        readOnly={checkout?.readAsGit === true}
      />
      {workspace ? (
        <PullStatus
          outcome={vcs.outcomes.get(WORKSPACE)}
          targetHead={target?.head ?? null}
          native={workspace.provider === "git"}
          running={vcs.running.has(WORKSPACE)}
          busy={vcs.busy}
          dispatch={vcs.dispatch}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        {view.kind === "loading" ? <LoadingBody /> : null}
        {view.kind === "none" ? (
          <p className="m-0 px-3 @md:px-4 py-8 text-[13px] leading-5 text-muted-foreground">
            {view.reason}
          </p>
        ) : null}
        {view.kind === "failed" ? (
          <FailedBody
            problem={view.problem}
            onRetry={onRetry}
            retrying={refresh.isPending}
            onReadAsGit={() => onReadAs("git")}
            switching={readAs.isPending}
          />
        ) : null}
        {view.kind === "ready" && checkout ? (
          <>
            {view.stale ? (
              <StaleBanner
                problem={view.stale}
                onRetry={onRetry}
                retrying={refresh.isPending}
                onReadAsGit={() => onReadAs("git")}
                switching={readAs.isPending}
              />
            ) : null}
            {checkout.readAsGit ? (
              <ReadAsGitNote onRestore={() => onReadAs("auto")} switching={readAs.isPending} />
            ) : null}
            <ReadyBody threadId={threadId} row={checkout} view={view} vcs={vcs} now={now} />
          </>
        ) : null}
      </div>
      {target ? <BaseFooter target={target} /> : null}
    </div>
  );
});

/** The workspace, its repository, how old the read is, and the target's new commits with Pull. */
function Header({
  repo,
  readState,
  target,
  vcs,
  readOnly,
}: {
  repo: string | null;
  readState: string | null;
  target: Target | null;
  vcs: Vcs;
  /** A GitButler workspace read as plain git: its writes would act on GitButler's own branch. */
  readOnly: boolean;
}) {
  return (
    <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-hairline px-3 @md:px-4 py-2.5">
      <div className="flex min-w-0 flex-[1_1_8rem] items-baseline gap-2">
        <h1 className="m-0 shrink-0 text-[13px] leading-5 font-semibold text-foreground">
          Workspace
        </h1>
        {repo ? (
          <span className="min-w-0 truncate text-[12px] leading-5 text-muted-foreground">
            {repo}
          </span>
        ) : null}
      </div>
      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <span
          className="shrink-0 text-[12px] leading-5 text-muted-foreground"
          data-testid="sc-read-state"
        >
          {readState}
        </span>
        {target && target.behind > 0 ? (
          <span
            className="min-w-0 truncate text-[12px] leading-5 text-warning"
            data-testid="sc-behind"
          >
            {shortRef(target.ref)} has {plural(target.behind, "new commit")}
          </span>
        ) : null}
        {target && !readOnly ? (
          <PullButton
            behind={target.behind}
            targetHead={target.head}
            running={vcs.running.has(WORKSPACE)}
            busy={vcs.busy}
            dispatch={vcs.dispatch}
          />
        ) : null}
      </div>
    </header>
  );
}

/** "Stack is based on origin/main a41c9e2". */
function BaseFooter({ target }: { target: Target }) {
  if (!target.base) return null;
  return (
    <footer
      className="flex min-w-0 shrink-0 flex-wrap items-baseline gap-x-1.5 border-t border-border-hairline px-3 @md:px-4 py-2 text-[12px] leading-4 text-muted-foreground"
      data-testid="sc-base"
    >
      <span>Stack is based on</span>
      <span className="min-w-0 truncate font-semibold text-foreground">{target.ref}</span>
      <span className="shrink-0 font-mono text-(--tertiary-foreground)" title={target.base.subject}>
        {shortId(target.base.id)}
      </span>
    </footer>
  );
}

/** This thread, the uncommitted files, and every stack. */
function ReadyBody({
  threadId,
  row,
  view,
  vcs,
  now,
}: {
  threadId: string;
  row: CheckoutChange;
  view: Extract<TabView, { kind: "ready" }>;
  vcs: Vcs;
  now: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggleCommit = useCallback(
    (key: string) => setExpanded((current) => (current === key ? null : key)),
    [],
  );
  const { workspace } = view;
  const native = workspace.provider === "git";
  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 @md:p-4">
      <ThisThread
        branchName={row.branch}
        branch={view.branch}
        workspace={workspace}
        forge={row.forge}
        offline={view.stale?.kind === "host-offline"}
      />
      <UncommittedCard
        threadId={threadId}
        changes={workspace.uncommitted}
        more={workspace.moreUncommitted}
        conflicted={workspace.conflicted.length}
      />
      {workspace.stacks.map((stack) => (
        <StackLane
          key={stack.key}
          threadId={threadId}
          stack={stack}
          threadBranch={row.branch}
          forge={row.forge.read?.value}
          behind={workspace.target?.behind ?? 0}
          targetHead={workspace.target?.head ?? null}
          native={native}
          outcomes={vcs.outcomes}
          running={vcs.running}
          busy={vcs.busy}
          dispatch={vcs.dispatch}
          readOnly={row.readAsGit}
          expanded={expanded}
          now={now}
          onToggleCommit={toggleCommit}
        />
      ))}
      {workspace.stacks.length === 0 ? (
        <p className="m-0 text-[12px] leading-4 text-muted-foreground">
          {native
            ? "This checkout has a detached HEAD, so there is no branch to show."
            : "No branches are applied in this GitButler workspace."}
        </p>
      ) : null}
    </div>
  );
}

function LoadingBody() {
  return (
    <div
      data-testid="sc-loading"
      aria-busy="true"
      aria-label="Reading this checkout"
      className="flex flex-col gap-4 p-3 @md:p-4"
    >
      <div className="flex flex-col gap-3">
        <Bar className="h-2.5 w-18" />
        <div className="flex items-center gap-2">
          <Bar className="h-6 w-16 rounded-full" />
          <Bar className="h-5 w-57.5 max-w-full" />
        </div>
        <Bar className="h-2.5 w-50 max-w-full" />
      </div>
      <Bar className="h-10 w-full rounded-[8px]" />
      <div className="flex flex-col gap-3 rounded-[8px] border border-border-hairline p-3">
        <Bar className="h-2.5 w-30" />
        <div className="flex items-center gap-2">
          <Bar className="size-4" />
          <Bar className="h-2.5 w-52.5 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Bar className="size-4" />
          <Bar className="h-2.5 w-42.5 max-w-full" />
        </div>
      </div>
    </div>
  );
}

function StaleBanner({
  problem,
  onRetry,
  retrying,
  onReadAsGit,
  switching,
}: {
  problem: Problem;
  onRetry(): void;
  retrying: boolean;
  onReadAsGit(): void;
  switching: boolean;
}) {
  const noBut = problem.kind === "tool-missing" && problem.tool === "but";
  return (
    <output
      data-testid="sc-stale"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-hairline bg-surface-recessed px-3 @md:px-4 py-2"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        {describeProblem(problem)} This is what bb last read.
      </span>
      <Button variant="ghost" className="font-semibold" onClick={onRetry} disabled={retrying}>
        {retrying ? "Trying…" : "Try again"}
      </Button>
      {noBut ? (
        <Button variant="ghost" onClick={onReadAsGit} disabled={switching}>
          Read as plain git
        </Button>
      ) : null}
    </output>
  );
}

function ReadAsGitNote({ onRestore, switching }: { onRestore(): void; switching: boolean }) {
  return (
    <div
      data-testid="sc-read-as-git"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-hairline px-3 @md:px-4 py-2"
    >
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        This GitButler workspace is read as plain git.
      </span>
      <Button variant="ghost" onClick={onRestore} disabled={switching}>
        Read as GitButler
      </Button>
    </div>
  );
}

function FailedBody({
  problem,
  onRetry,
  retrying,
  onReadAsGit,
  switching,
}: {
  problem: Problem;
  onRetry(): void;
  retrying: boolean;
  onReadAsGit(): void;
  switching: boolean;
}) {
  const detail = "detail" in problem ? problem.detail : null;
  const noBut = problem.kind === "tool-missing" && problem.tool === "but";
  return (
    <div data-testid="sc-failed" role="alert" className="flex flex-col gap-3 px-3 @md:px-4 py-8">
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
        <span className="text-[14px] leading-5 font-semibold text-foreground">
          Couldn't read this checkout
        </span>
      </div>
      <p className="m-0 text-[13px] leading-5 text-muted-foreground">{describeProblem(problem)}</p>
      {detail ? (
        <p className="m-0 font-mono text-[12px] leading-5 break-words text-muted-foreground">
          {detail}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button onClick={onRetry} disabled={retrying}>
          {retrying ? "Trying…" : "Try again"}
        </Button>
        {noBut ? (
          <Button onClick={onReadAsGit} disabled={switching}>
            Read as plain git
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const PR_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;

function PullRequestChip({
  forge,
  onGitHub,
}: {
  forge: ForgeValue | undefined;
  onGitHub: boolean;
}) {
  const label = !onGitHub
    ? "Local"
    : forge === undefined
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

function forgeLine(forge: Facet<ForgeValue>, workspace: WorkspaceValue, branch: Branch | null) {
  const pr = forge.read?.value;
  if (forge.problem) return describeProblem(forge.problem);
  if (pr === undefined)
    return workspace.github
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
  const behind = branch && forgeIsBehind(branch, pr) ? " · GitHub has an older head" : "";
  return `#${pr.number} · ${checks}${behind}`;
}

function localLine(branch: Branch | null, workspace: WorkspaceValue): string {
  const parts: string[] = [];
  const uncommitted = uncommittedCount(workspace);
  parts.push(uncommitted === 0 ? "No uncommitted changes" : `${uncommitted} uncommitted`);
  if (workspace.conflicted.length > 0) parts.push(`${workspace.conflicted.length} conflicted`);
  if (branch) {
    parts.push(plural(branch.commits.length + branch.moreCommits, "commit"));
    if (!branch.remote) parts.push("not pushed");
    else {
      if (branch.ahead > 0) parts.push(`${branch.ahead} to push`);
      if (branch.behind > 0) parts.push(`${branch.behind} to pull`);
      if (branch.ahead === 0 && branch.behind === 0) parts.push("pushed");
    }
  }
  return parts.join(" · ");
}

/** The thread's own Change: its pull request over its branch. */
function ThisThread({
  branchName,
  branch,
  workspace,
  forge,
  offline,
}: {
  branchName: string | null;
  branch: Branch | null;
  workspace: WorkspaceValue;
  forge: Facet<ForgeValue>;
  offline: boolean;
}) {
  const pr = forge.read?.value;
  const name = branch?.name ?? branchName;
  return (
    <section
      data-testid="sc-ready"
      className="flex min-w-0 flex-col gap-2"
      aria-label="This thread"
    >
      <SectionLabel>This thread</SectionLabel>
      <div className="flex min-w-0 items-center gap-2">
        <PullRequestChip forge={pr} onGitHub={workspace.github !== null} />
        <span
          className="min-w-0 truncate text-[15px] leading-6 font-semibold text-foreground"
          data-testid="sc-title"
        >
          {pr ? pr.title : (name ?? "No branch")}
        </span>
      </div>
      <span
        className="text-[12px] leading-4 break-words text-muted-foreground"
        data-testid="sc-forge-line"
      >
        {forgeLine(forge, workspace, branch)}
      </span>
      <span
        className="text-[12px] leading-4 break-words text-muted-foreground"
        data-testid="sc-local-line"
      >
        {name ? (
          <>
            <span className="font-mono">{name}</span> ·{" "}
          </>
        ) : (
          "This thread has no branch of its own here · "
        )}
        {localLine(branch, workspace)}
      </span>
      {offline ? (
        <span className="text-[12px] leading-4 text-muted-foreground">
          Push, pull, and land need the host. Pull request state still comes from GitHub.
        </span>
      ) : null}
    </section>
  );
}
