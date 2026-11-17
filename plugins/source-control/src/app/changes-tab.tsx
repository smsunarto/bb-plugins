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
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  describeProblem,
  forgeIsBehind,
  readAgo,
  tabView,
  changeKeyForBranch,
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
import { FindingsCard } from "./findings-card.tsx";
import { HostGate, NO_CHECKOUT, offlineReason } from "./host-gate.ts";
import { plural, shortRef } from "./format.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";
import { BotIcon } from "./page/ask-panel.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { OpenOnGitHub, Pending, SectionLabel } from "./ui.tsx";
import { CommitControl } from "./commit.tsx";
import { BaseCard } from "./base-card.tsx";
import { HistoryCard } from "./history.tsx";
import { OtherMachinesCard } from "./other-machines.tsx";
import { CARD, StackLane, UncommittedCard } from "./workspace-lane.tsx";
import { attentionChips, summarize } from "../core/status.ts";
import { Chips, usePullRequestActions } from "./status.tsx";

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

/** The one host gate (plan §3): every host-bound control and write reads it. */
function hostGateOf(
  checkout: Extract<ThreadChange, { state: "checkout" }> | null,
  view: ReturnType<typeof tabView>,
): string | null {
  if (!checkout) return NO_CHECKOUT;
  if (view.kind === "ready" && view.stale?.kind === "host-offline")
    return offlineReason(checkout.placement.hostName);
  return null;
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
  const view = tabView(row);
  const checkout = row?.state === "checkout" ? row : null;
  const gate = hostGateOf(checkout, view);
  const vcs = useVcsActions(threadId, gate);
  const now = useNow();
  const workspace = view.kind === "ready" ? view.workspace : null;
  const target = workspace?.target ?? null;

  return (
    <HostGate value={gate}>
      <div
        data-bb-plugin="source-control"
        data-testid="sc-changes"
        className="@container flex h-full min-h-0 min-w-0 flex-col text-foreground"
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
            <p className="m-0 px-3 max-md:px-4 @md:px-4 py-8 text-[13px] leading-5 text-muted-foreground">
              {view.reason}
            </p>
          ) : null}
          {view.kind === "failed" ? (
            <FailedBody
              threadId={threadId}
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
      </div>
    </HostGate>
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
    <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-hairline px-3 max-md:px-4 @md:px-4 py-2 min-h-12">
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
  const hostId = row.placement.hostId;
  // The thread's own branch is the row's Change; the others are keyed as the nav keys them.
  const keyOf = useCallback(
    (branch: Branch) =>
      branch.name === row.branch ? row.key : changeKeyForBranch(hostId, workspace, branch),
    [row.branch, row.key, hostId, workspace],
  );
  return (
    <>
      <div className="flex min-w-0 flex-col gap-4 p-3 max-md:p-4 @md:p-4">
        <ThisThread
          threadId={threadId}
          row={row}
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
          commit={
            row.readAsGit ? null : (
              <CommitControl
                changes={workspace.uncommitted}
                more={workspace.moreUncommitted}
                branches={commitBranches(workspace)}
                preferred={row.branch}
                targetHead={workspace.target?.head ?? null}
                running={vcs.running}
                busy={vcs.busy}
                dispatch={vcs.dispatch}
              />
            )
          }
        />
        {workspace.stacks.map((stack) => (
          <StackLane
            key={stack.key}
            threadId={threadId}
            keyOf={keyOf}
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
        {workspace.target?.base ? (
          <BaseCard
            threadId={threadId}
            target={{ ...workspace.target, base: workspace.target.base }}
            now={now}
            className={CARD}
          />
        ) : null}
        {workspace.github ? (
          <OtherMachinesCard
            threadId={threadId}
            hostId={row.placement.hostId}
            repo={`${workspace.github.repo.owner}/${workspace.github.repo.name}`}
            changeKey={row.key}
            now={now}
            className={CARD}
          />
        ) : null}
        {native ? null : (
          <HistoryCard threadId={threadId} path={workspace.path} now={now} className={CARD} />
        )}
      </div>
    </>
  );
}

/** Where a commit may go: any applied branch in GitButler, the checked-out one in plain git. */
function commitBranches(workspace: WorkspaceValue): Branch[] {
  const all = workspace.stacks.flatMap((stack) => stack.branches);
  return workspace.provider === "git"
    ? all.filter((branch) => branch.name === workspace.checkedOut)
    : all;
}

function LoadingBody() {
  return (
    <div
      data-testid="sc-loading"
      aria-busy="true"
      aria-label="Reading this checkout"
      className="flex flex-col gap-4 p-3 max-md:p-4 @md:p-4"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-18" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-5 w-58 max-w-full" />
        </div>
        <Skeleton className="h-3 w-50 max-w-full" />
      </div>
      <Skeleton className="h-10 w-full rounded-[8px]" />
      <div className="flex flex-col gap-3 rounded-[8px] border border-border-hairline p-3">
        <Skeleton className="h-3 w-30" />
        <div className="flex items-center gap-2">
          <Skeleton className="size-4" />
          <Skeleton className="h-3 w-52 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="size-4" />
          <Skeleton className="h-3 w-42 max-w-full" />
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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-hairline bg-surface-recessed px-3 max-md:px-4 @md:px-4 py-2"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        {describeProblem(problem)} This is what bb last read.
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 font-semibold"
        onClick={onRetry}
        disabled={retrying}
      >
        {retrying ? "Trying…" : "Try again"}
      </Button>
      {noBut ? (
        <Button
          size="sm"
          className="h-7"
          variant="ghost"
          onClick={onReadAsGit}
          disabled={switching}
        >
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
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-hairline px-3 max-md:px-4 @md:px-4 py-2"
    >
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        This GitButler workspace is read as plain git.
      </span>
      <Button size="sm" className="h-7" variant="ghost" onClick={onRestore} disabled={switching}>
        Read as GitButler
      </Button>
    </div>
  );
}

/** "Ask agent to fix" (board C): a thread on the checkout's host to install the missing tool. */
function AskToFix({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "askToFix" });
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    setError(null);
    try {
      const result = await mutation.mutate({ threadId });
      if (result.ok) navigate.toThread(result.threadId);
      else setError(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't start the agent.");
    }
  };
  return (
    <>
      <Button
        size="sm"
        variant="default"
        data-testid="sc-ask-to-fix"
        className="h-7 bg-(--primary) font-semibold text-primary-foreground enabled:hover:bg-(--primary) enabled:hover:opacity-90"
        onClick={() => void onClick()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? <Pending pending /> : <BotIcon size={13} />}
        Ask agent to fix
      </Button>
      {error ? (
        <span role="alert" className="basis-full text-[12px] leading-4 text-warning">
          {error}
        </span>
      ) : null}
    </>
  );
}

function FailedBody({
  threadId,
  problem,
  onRetry,
  retrying,
  onReadAsGit,
  switching,
}: {
  threadId: string;
  problem: Problem;
  onRetry(): void;
  retrying: boolean;
  onReadAsGit(): void;
  switching: boolean;
}) {
  const detail = "detail" in problem ? problem.detail : null;
  const noBut = problem.kind === "tool-missing" && problem.tool === "but";
  return (
    <div
      data-testid="sc-failed"
      role="alert"
      className="flex flex-col gap-3 px-3 max-md:px-4 @md:px-4 py-8"
    >
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
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {problem.kind === "tool-missing" ? <AskToFix threadId={threadId} /> : null}
        <Button size="sm" className="h-7" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? "Trying…" : "Try again"}
        </Button>
        {noBut ? (
          <Button
            size="sm"
            className="h-7"
            variant="outline"
            onClick={onReadAsGit}
            disabled={switching}
          >
            Read as plain git
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const PR_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;

function chipLabel(forge: ForgeValue | undefined, onGitHub: boolean): string {
  if (!onGitHub) return "Local";
  if (forge === undefined) return "Unknown";
  if (forge === null) return "No PR";
  return forge.isDraft && forge.state === "open" ? "Draft" : PR_LABEL[forge.state];
}

/** The pull request chip's pill shape, as a Badge and as the menu's Button. */
const CHIP = "h-6 gap-1 rounded-full px-2 [&_svg]:size-3";

/**
 * The pull request's state; for an open one, a menu with Mark ready for
 * review or Convert to draft, and Close.
 */
function PullRequestChip({
  threadId,
  forge,
  onGitHub,
}: {
  threadId: string;
  forge: ForgeValue | undefined;
  onGitHub: boolean;
}) {
  const label = chipLabel(forge, onGitHub);
  const draft = usePullRequestActions(threadId, forge ?? null);
  if (!draft.toggle || !forge)
    return (
      <Badge variant="secondary" data-testid="sc-pr-chip" className={CHIP}>
        {label}
      </Badge>
    );
  return (
    <span className="relative flex shrink-0 flex-col">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" data-testid="sc-pr-chip" className={CHIP}>
            {label}
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
              <path
                d="M3 4.5L6 7.5L9 4.5"
                fill="none"
                stroke="var(--tertiary-foreground)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            data-testid="sc-draft-toggle"
            disabled={draft.pending}
            onSelect={() => draft.toggle?.()}
          >
            {forge.isDraft ? "Mark ready for review" : "Convert to draft"}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            data-testid="sc-close-pr"
            disabled={draft.pending}
            onSelect={() => draft.close?.()}
          >
            Close pull request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {draft.message ? (
        <output className="text-[12px] leading-4 text-warning">{draft.message}</output>
      ) : null}
    </span>
  );
}

/**
 * What the header's second line cannot say: the pull request is still being
 * read, cannot be read, or is behind; the branch is not pushed or out of step.
 * Null when the line says it all.
 */
function headerNote(
  forge: Facet<ForgeValue>,
  workspace: WorkspaceValue,
  branch: Branch | null,
): string | null {
  const pr = forge.read?.value;
  const notes: string[] = [];
  if (forge.problem) notes.push(describeProblem(forge.problem));
  else if (pr === undefined)
    notes.push(
      workspace.github
        ? "Reading the pull request…"
        : "No GitHub remote; this Change is local to its checkout.",
    );
  else if (pr === null) notes.push("No pull request for this branch yet.");
  else if (branch && forgeIsBehind(branch, pr)) notes.push("GitHub has an older head.");
  if (workspace.conflicted.length > 0) notes.push(`${workspace.conflicted.length} conflicted`);
  if (branch && !branch.remote) notes.push("Not pushed.");
  else if (branch && (branch.ahead > 0 || branch.behind > 0))
    notes.push(
      [
        branch.ahead > 0 ? `${branch.ahead} to push` : null,
        branch.behind > 0 ? `${branch.behind} to pull` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  return notes.length > 0 ? notes.join(" ") : null;
}

/** "· #482 · 3 commits", the part of board B's second line after the branch. */
function headerCounts(pr: ForgeValue | undefined, branch: Branch | null): string {
  const commits = pr ? pr.commits : branch ? branch.commits.length + branch.moreCommits : 0;
  return [pr ? `#${pr.number}` : null, plural(commits, "commit")].filter(Boolean).join(" · ");
}

/** The thread's own Change, as board B heads it: state and title, then branch, number, commits and size. */
function ThisThread({
  threadId,
  row,
  branchName,
  branch,
  workspace,
  forge,
  offline,
}: {
  threadId: string;
  row: ThreadChange;
  branchName: string | null;
  branch: Branch | null;
  workspace: WorkspaceValue;
  forge: Facet<ForgeValue>;
  offline: boolean;
}) {
  const pr = forge.read?.value;
  const name = branch?.name ?? branchName;
  const chips = useMemo(() => {
    const summary = summarize(row);
    return summary ? attentionChips(summary) : [];
  }, [row]);
  const note = headerNote(forge, workspace, branch);
  const uncommitted = uncommittedCount(workspace);
  const visible = useTabVisible();
  const changeKey = row.state === "checkout" ? row.key : null;
  return (
    <section
      data-testid="sc-ready"
      className="flex min-w-0 flex-col gap-2"
      aria-label="This thread"
    >
      <SectionLabel>This thread</SectionLabel>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <PullRequestChip threadId={threadId} forge={pr} onGitHub={workspace.github !== null} />
          <span
            className="min-w-0 flex-1 truncate text-[16px] leading-6 font-semibold text-foreground"
            data-testid="sc-title"
          >
            {pr ? pr.title : (name ?? "No branch")}
          </span>
          {pr ? <OpenOnGitHub href={pr.url} label={`Open #${pr.number} on GitHub`} /> : null}
        </div>
        <span
          className="flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] leading-4"
          data-testid="sc-local-line"
        >
          {name ? (
            <span className="min-w-0 truncate font-mono text-muted-foreground">{name}</span>
          ) : (
            <span className="text-muted-foreground">This thread has no branch of its own here</span>
          )}
          <span className="text-(--tertiary-foreground)">· {headerCounts(pr, branch)}</span>
          {pr ? (
            <>
              <span className="font-mono text-success-foreground">+{pr.additions}</span>
              <span className="font-mono text-destructive-text">−{pr.deletions}</span>
            </>
          ) : null}
          {!pr && uncommitted > 0 ? (
            <span className="text-(--tertiary-foreground)">· {uncommitted} uncommitted</span>
          ) : null}
        </span>
      </div>
      <Chips chips={chips} />
      {note ? (
        <span
          className="text-[12px] leading-4 break-words text-muted-foreground"
          data-testid="sc-forge-line"
        >
          {note}
        </span>
      ) : null}
      {offline ? (
        <span className="text-[12px] leading-4 text-muted-foreground">
          Push, pull, and land need the host. Pull request state still comes from GitHub.
        </span>
      ) : null}
      {changeKey ? (
        <FindingsCard
          key={changeKey}
          changeKey={changeKey}
          threadId={threadId}
          head={branch?.head ?? null}
          visible={visible}
        />
      ) : null}
    </section>
  );
}
