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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  HostWritesBlocked,
  PullButton,
  PullStatus,
  WORKSPACE,
  useVcsActions,
} from "./branch-actions.tsx";
import { FindingsCard } from "./findings-card.tsx";
import { cx, plural, shortId, shortRef } from "./format.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";
import { BotIcon } from "./page/ask-panel.tsx";
import { Bar, Button, Pending, SectionLabel } from "./ui.tsx";
import { CommitControl } from "./commit.tsx";
import { BaseCard } from "./base-card.tsx";
import { HistoryCard } from "./history.tsx";
import { OtherMachinesCard } from "./other-machines.tsx";
import { CARD, StackLane, UncommittedCard } from "./workspace-lane.tsx";
import { attentionChips, summarize } from "../core/status.ts";
import { Chips, useDraftToggle } from "./status.tsx";

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
  const hostId = row.placement.hostId;
  // The thread's own branch is the row's Change; the others are keyed as the nav keys them.
  const keyOf = useCallback(
    (branch: Branch) =>
      branch.name === row.branch ? row.key : changeKeyForBranch(hostId, workspace, branch),
    [row.branch, row.key, hostId, workspace],
  );
  const hostDown =
    view.stale?.kind === "host-offline"
      ? `${row.placement.hostName} is offline. Rename, push, land and delete need it.`
      : null;
  return (
    <HostWritesBlocked value={hostDown}>
      <div className="flex min-w-0 flex-col gap-4 p-3 @md:p-4">
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
    </HostWritesBlocked>
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
      <button
        type="button"
        data-testid="sc-ask-to-fix"
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-(--primary) px-2.5 text-[12px] leading-4 font-semibold text-primary-foreground disabled:cursor-default disabled:opacity-60"
        onClick={() => void onClick()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? <Pending pending /> : <BotIcon size={13} />}
        Ask agent to fix
      </button>
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
        {problem.kind === "tool-missing" ? <AskToFix threadId={threadId} /> : null}
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

function chipLabel(forge: ForgeValue | undefined, onGitHub: boolean): string {
  if (!onGitHub) return "Local";
  if (forge === undefined) return "Unknown";
  if (forge === null) return "No PR";
  return forge.isDraft && forge.state === "open" ? "Draft" : PR_LABEL[forge.state];
}

const CHIP =
  "flex h-6 shrink-0 items-center gap-1 rounded-full bg-border px-2 text-[12px] leading-4 font-semibold text-foreground";

/**
 * The pull request's state; for an open one, a menu with Mark ready for
 * review or Convert to draft. Escape closes it and returns focus.
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
  const draft = useDraftToggle(threadId, forge ?? null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) item.current?.focus();
  }, [open]);
  if (!draft.toggle || !forge)
    return (
      <span data-testid="sc-pr-chip" className={CHIP}>
        {label}
      </span>
    );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <span className="relative flex shrink-0 flex-col">
      <button
        ref={trigger}
        type="button"
        data-testid="sc-pr-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cx(CHIP, "cursor-pointer border-0 enabled:hover:bg-border")}
      >
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
      </button>
      {open ? (
        <span
          role="menu"
          tabIndex={-1}
          className="absolute top-7 left-0 z-10 flex min-w-48 flex-col rounded-[8px] border border-solid border-border bg-popover p-1 shadow-md"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <button
            type="button"
            ref={item}
            role="menuitem"
            data-testid="sc-draft-toggle"
            disabled={draft.pending}
            onClick={() => {
              draft.toggle?.();
              close();
            }}
            className="flex h-7 cursor-pointer items-center rounded-[6px] border-0 bg-transparent px-2 text-left text-[12px] leading-4 text-foreground enabled:hover:bg-surface-raised"
          >
            {forge.isDraft ? "Mark ready for review" : "Convert to draft"}
          </button>
        </span>
      ) : null}
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

function GitHubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="currentColor"
      />
    </svg>
  );
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
          {pr ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open #${pr.number} on GitHub`}
              title="Open in GitHub"
              className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-solid border-border text-foreground transition-colors hover:bg-surface-raised motion-reduce:transition-none"
            >
              <GitHubMark />
            </a>
          ) : null}
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
