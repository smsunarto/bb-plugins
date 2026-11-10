/**
 * The workspace drawn the way GitButler desktop draws a stack lane: branch
 * cards with a coloured status square, commits strung on a vertical line whose
 * colour and dot shape say where each commit lives, and file rows ending in a
 * change-kind glyph. Ported from `plugins/gitbutler/src/app/workspace-lane.tsx`.
 */
import { experimental_Icon as Icon, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  describeProblem,
  type Branch,
  type BranchStatus,
  type Commit,
  type FileChange,
  type ForgeValue,
  type PatchSource,
  type Stack,
  type VcsAction,
} from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { reviewPath } from "../core/review.ts";
import { BranchActions, type Dispatch, type Outcome } from "./branch-actions.tsx";
import {
  FileDiffCard,
  FileRows,
  FileRowsSkeleton,
  PatchesProblem,
  UncommittedDiff,
  usePatches,
} from "./file-cards.tsx";
import { absoluteTime, cx, plural, shortAge } from "./format.ts";
import { Count, SectionLabel } from "./ui.tsx";

const CARD =
  "min-w-0 overflow-hidden rounded-[8px] border border-border-hairline bg-surface-recessed";
// Inside a card: a divider and a muted label, as GitButler heads a sub-list.
const CARD_LABEL =
  "m-0 flex items-center gap-1.5 border-t border-border-hairline px-3 py-2 text-[11px] leading-4 font-medium text-muted-foreground";

/*
 * GitButler's commit states, in the theme's palette. Text colour, not
 * background, so a solid segment (`bg-current`) and a dashed one (a
 * `currentColor` gradient) read the same class.
 */
export type Tone = "local" | "remote" | "upstream" | "integrated" | "conflicted";

export const TONE: Readonly<Record<Tone, string>> = {
  local: "text-(--tertiary-foreground)",
  remote: "text-(--info)",
  upstream: "text-warning",
  integrated: "text-(--pr-merged)",
  conflicted: "text-destructive",
};

/**
 * One row per push status. Every commit on a branch takes the branch's tone,
 * since the status is the branch's, not each commit's.
 */
export const BRANCH_LOOK: Readonly<
  Record<BranchStatus, { tone: Tone; icon: string; label: string; diamond: boolean }>
> = {
  unpushed: { tone: "local", icon: "GitBranch", label: "Unpushed", diamond: false },
  pushed: { tone: "remote", icon: "GitBranch", label: "Pushed", diamond: true },
  ahead: { tone: "remote", icon: "ArrowUp", label: "Ahead", diamond: false },
  behind: { tone: "remote", icon: "ArrowDown", label: "Behind", diamond: false },
  diverged: { tone: "remote", icon: "ArrowUpDown", label: "Diverged", diamond: false },
  integrated: { tone: "integrated", icon: "GitMerge", label: "Integrated", diamond: false },
  conflicted: { tone: "conflicted", icon: "AlertTriangle", label: "Conflicted", diamond: false },
  empty: { tone: "local", icon: "GitBranch", label: "Empty", diamond: false },
  unknown: { tone: "local", icon: "GitBranch", label: "", diamond: false },
};

type Segment = "solid" | "dashed";

const DASHED = "bg-[linear-gradient(to_bottom,currentColor_50%,transparent_50%)] bg-size-[2px_4px]";

/**
 * The commit graph cell: a 2px line broken by the commit's dot. Its centre is
 * the axis every branch square and connector in the lane sits on, 20px in from
 * the card's inner edge.
 */
export function Rail({
  tone,
  diamond,
  bottom = "solid",
}: {
  tone: Tone;
  diamond: boolean;
  bottom?: Segment;
}) {
  return (
    <span
      className={cx("flex w-10 shrink-0 flex-col items-center gap-[3px]", TONE[tone])}
      aria-hidden
    >
      <span className="w-0.5 flex-1 bg-current" />
      <span
        className={cx(
          "size-2.5 shrink-0 bg-current",
          diamond ? "scale-[0.86] rotate-45 rounded-[2px]" : "rounded-full",
        )}
      />
      <span className={cx("w-0.5 flex-1", bottom === "dashed" ? DASHED : "bg-current")} />
    </span>
  );
}

/** Where a commit row sits, and so the key that opens it. */
type Where = "local" | "upstream";

export function commitKey(where: Where, commitId: string): string {
  return `${where}:${commitId}`;
}

/** Opens the review page at this commit's file, for a branch that is a Change. */
function ReviewJump({
  changeKey,
  commitId,
  path,
}: {
  changeKey: ChangeKey;
  commitId: string;
  path: string;
}) {
  const navigate = useBbNavigate();
  return (
    <div className="flex justify-end border-t border-border-hairline px-3.5 py-1">
      <button
        type="button"
        data-testid="sc-review-jump"
        onClick={() =>
          navigate.toPluginPanel("source-control", {
            subPath: reviewPath({ key: changeKey, tab: "commits", commit: commitId, path }),
          })
        }
        className="flex h-6 cursor-pointer items-center gap-1 rounded-[6px] border-0 bg-transparent px-1.5 text-[11px] leading-4 text-muted-foreground hover:bg-surface-raised hover:text-foreground"
      >
        Open in Review
        <Icon name="ArrowUpRight" fallback="ExternalLink" className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/** A commit's changed files, under its row, read when the row opens. */
function CommitFiles({
  threadId,
  commitId,
  reviewKey,
}: {
  threadId: string;
  commitId: string;
  /** The branch's Change, when it has one: its open file links to the review page. */
  reviewKey: ChangeKey | null;
}) {
  const source = useMemo<PatchSource>(() => ({ kind: "commit", commitId }), [commitId]);
  const read = usePatches(threadId, source);
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = useCallback(
    (path: string) => setExpanded((current) => (current === path ? null : path)),
    [],
  );
  const answer = read.data;
  const files = answer?.ok ? answer.value.files : undefined;
  const changes = useMemo<FileChange[]>(
    () => (files ?? []).map((file) => ({ path: file.path, kind: file.kind })),
    [files],
  );
  if (answer === undefined) {
    if (read.error)
      return <PatchesProblem text={read.error.message} onRetry={() => void read.refetch()} />;
    return <FileRowsSkeleton label="Loading changes…" />;
  }
  if (!answer.ok)
    return (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void read.refetch()} />
    );
  if (changes.length === 0)
    return (
      <p className="m-0 px-3.5 py-2 text-[12px] leading-4 text-muted-foreground">
        This commit records no file contents. Merges and empty commits look like this.
      </p>
    );
  const open = expanded === null ? undefined : files?.find((file) => file.path === expanded);
  return (
    <FileRows
      changes={changes}
      expanded={expanded}
      onToggle={toggle}
      diff={
        open ? (
          <>
            {reviewKey ? (
              <ReviewJump changeKey={reviewKey} commitId={commitId} path={open.path} />
            ) : null}
            <FileDiffCard file={open} />
          </>
        ) : null
      }
    />
  );
}

/** One commit. Memoized on its row object; opening it redraws only it and the one it closes. */
const CommitRow = memo(function CommitRow({
  threadId,
  commit,
  where,
  tone,
  diamond,
  bottom,
  last,
  open,
  now,
  onToggle,
  reviewKey,
}: {
  threadId: string;
  reviewKey: ChangeKey | null;
  commit: Commit;
  where: Where;
  tone: Tone;
  diamond: boolean;
  bottom: Segment;
  last: boolean;
  open: boolean;
  now: number;
  onToggle: (key: string) => void;
}) {
  const title = commit.subject;
  const railTone = commit.conflicted ? "conflicted" : tone;
  const age = commit.createdAt ? shortAge(commit.createdAt, now) : "";
  return (
    <li className="min-w-0">
      <button
        type="button"
        className={cx(
          // The card clips outside the row, so the focus outline is drawn inside it.
          "group relative flex w-full min-w-0 cursor-pointer items-stretch text-start text-[13px] leading-5 hover:bg-surface-raised focus-visible:-outline-offset-2 aria-expanded:bg-surface-raised",
          commit.conflicted && "bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)]",
        )}
        onClick={() => onToggle(commitKey(where, commit.id))}
        aria-expanded={open}
        title={title || "No commit message"}
      >
        {/* GitButler's marker for the open commit, on the card's edge. */}
        {open ? (
          <span
            className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-(--info)"
            aria-hidden
          />
        ) : null}
        <Rail tone={railTone} diamond={diamond} bottom={bottom} />
        {/* The rule stops at the rail, so the graph line never breaks. */}
        <span
          className={cx(
            "flex min-w-0 flex-1 items-center gap-2 py-2 pe-3",
            !last && !open && "border-b border-border-hairline",
          )}
        >
          {commit.conflicted ? (
            <Icon
              name="AlertTriangle"
              className="size-3.5 shrink-0 text-destructive"
              aria-label="Conflicted"
            />
          ) : null}
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-medium text-foreground",
              commit.conflicted && "text-destructive",
              !title && "font-normal text-muted-foreground italic",
            )}
          >
            {title || "No commit message"}
          </span>
          {age ? (
            <time
              dateTime={commit.createdAt ?? undefined}
              title={commit.createdAt ? absoluteTime(commit.createdAt) : undefined}
              className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
            >
              {age}
            </time>
          ) : null}
          <Icon
            name="ChevronDown"
            className="size-3 shrink-0 -rotate-90 text-muted-foreground transition-transform duration-150 group-aria-expanded:rotate-0 motion-reduce:transition-none"
            aria-hidden
          />
        </span>
      </button>
      {open ? (
        <OpenCommit
          threadId={threadId}
          reviewKey={reviewKey}
          commitId={commit.id}
          tone={railTone}
          bottom={bottom}
          last={last}
        />
      ) : null}
    </li>
  );
});

/** Under an open commit row: its files, with the rail running on behind them. */
function OpenCommit({
  threadId,
  reviewKey,
  commitId,
  tone,
  bottom,
  last,
}: {
  threadId: string;
  reviewKey: ChangeKey | null;
  commitId: string;
  tone: Tone;
  bottom: Segment;
  last: boolean;
}) {
  return (
    <>
      <div className="relative px-3 pt-0.5 pb-3">
        {/* The rail runs on behind the files, so the graph reads unbroken. */}
        <span
          className={cx(
            "absolute inset-y-0 left-[19px] w-0.5",
            TONE[tone],
            bottom === "dashed" ? DASHED : "bg-current",
          )}
          aria-hidden
        />
        <div className="relative min-w-0 overflow-hidden rounded-[6px] border border-border-hairline bg-background">
          <CommitFiles threadId={threadId} commitId={commitId} reviewKey={reviewKey} />
        </div>
      </div>
      {last ? null : <div className="ms-10 border-b border-border-hairline" />}
    </>
  );
}

/**
 * GitButler's `ChangedFilesPanel`: a bordered card whose header folds it,
 * with the count. A file row opens its uncommitted diff in place.
 */
function ChangesCard({
  threadId,
  title,
  changes,
  more = 0,
  conflicted = 0,
  defaultOpen,
  attention = false,
  testId,
}: {
  threadId: string;
  title: string;
  changes: readonly FileChange[];
  more?: number;
  conflicted?: number;
  defaultOpen: boolean;
  attention?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = useCallback(
    (path: string) => setExpanded((current) => (current === path ? null : path)),
    [],
  );
  const count = changes.length + more;
  const empty = count === 0;
  return (
    <section className={CARD} aria-label={title} data-testid={testId}>
      <header
        className={cx(
          "flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2",
          attention && !empty && "bg-[color-mix(in_oklab,var(--warning)_12%,transparent)]",
        )}
      >
        <button
          type="button"
          className="flex min-h-6 min-w-0 flex-[1_1_11rem] cursor-pointer items-center gap-2 rounded-[4px] text-start focus-visible:-outline-offset-2 disabled:cursor-default"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open && !empty}
          disabled={empty}
        >
          <Icon
            name="ChevronDown"
            className={cx(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
              empty && "invisible",
            )}
            aria-hidden
          />
          <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
            {empty ? `No ${title.toLowerCase()}` : title}
          </span>
          {empty ? null : <Count>{count}</Count>}
        </button>
        {conflicted > 0 ? (
          <span className="shrink-0 text-[11px] leading-4 text-destructive">
            {plural(conflicted, "file")} with conflict markers
          </span>
        ) : null}
      </header>
      {open && !empty ? (
        <div className="border-t border-border-hairline">
          <FileRows
            changes={changes}
            more={more}
            expanded={expanded}
            onToggle={toggle}
            diff={expanded ? <UncommittedDiff threadId={threadId} path={expanded} /> : null}
          />
        </div>
      ) : null}
    </section>
  );
}

// Open while it fits at a glance; a busy worktree would bury the stacks.
const OPEN_UP_TO = 8;

/** Uncommitted files no stack holds. */
export function UncommittedCard({
  threadId,
  changes,
  more,
  conflicted,
}: {
  threadId: string;
  changes: readonly FileChange[];
  more: number;
  conflicted: number;
}) {
  return (
    <ChangesCard
      threadId={threadId}
      title="Uncommitted changes"
      changes={changes}
      more={more}
      conflicted={conflicted}
      defaultOpen={changes.length + more <= OPEN_UP_TO}
      attention
      testId="sc-uncommitted"
    />
  );
}

const CHIP =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] leading-none font-medium whitespace-nowrap";

/** A small pill beside the branch name, so status costs no row of its own. */
export function Chip({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx(CHIP, className)} title={title}>
      {children}
    </span>
  );
}

const OUTLINE_CHIP = "border border-border-hairline text-muted-foreground";

/** Chips tinted with a theme colour: the token's text on a faint fill of itself. */
const TINT = {
  success: "bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-success",
  warning: "bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-warning",
  destructive: "bg-[color-mix(in_oklab,var(--destructive)_14%,transparent)] text-destructive",
  merged: "bg-[color-mix(in_oklab,var(--pr-merged)_14%,transparent)] text-(--pr-merged)",
} as const;

const PR_LOOK = {
  open: { label: "Open", className: TINT.success },
  draft: { label: "Draft", className: "bg-surface-raised text-muted-foreground" },
  merged: { label: "Merged", className: TINT.merged },
  closed: { label: "Closed", className: TINT.destructive },
} as const;

/** The pull request's checks overall, from the forge facet. */
function ChecksChip({ checks }: { checks: NonNullable<ForgeValue>["checks"] }) {
  if (checks.failed > 0) return <Chip className={TINT.destructive}>{checks.failed} Failing</Chip>;
  if (checks.pending > 0)
    return (
      <Chip className={TINT.warning}>
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        {checks.pending} Running
      </Chip>
    );
  if (checks.passed > 0)
    return (
      <Chip className={TINT.success}>
        <Icon name="Check" className="size-3" aria-hidden />
        Passed
      </Chip>
    );
  return null;
}

/** A branch's review: its state and checks from the forge for the thread's own branch. */
function ReviewChips({ branch, forge }: { branch: Branch; forge: ForgeValue | undefined }) {
  if (forge) {
    const look = PR_LOOK[forge.state === "open" && forge.isDraft ? "draft" : forge.state];
    return (
      <>
        <UrlLink
          href={forge.url}
          className={cx(CHIP, look.className, "no-underline hover:opacity-90")}
          title={`Open PR #${forge.number}`}
        >
          #{forge.number} {look.label}
        </UrlLink>
        {forge.state === "open" ? <ChecksChip checks={forge.checks} /> : null}
      </>
    );
  }
  if (branch.reviewId) return <Chip className={OUTLINE_CHIP}>{branch.reviewId}</Chip>;
  return null;
}

/** A card's header: status square and name, then chips. */
function CardHeader({
  icon,
  tone,
  name,
  trailing,
}: {
  icon: string;
  tone: Tone;
  name: string;
  trailing: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
      <div className="flex min-w-0 flex-[1_1_8rem] items-center gap-2">
        {/* The square's centre sits on the commit rail's axis below it. */}
        <span
          className={cx(
            "ms-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-current",
            TONE[tone],
          )}
          aria-hidden
        >
          <Icon name={icon} className="size-3 text-background" />
        </span>
        <h3
          className="m-0 min-w-0 truncate text-[13px] leading-5 font-semibold text-foreground"
          title={name}
        >
          {name}
        </h3>
      </div>
      <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
        {trailing}
      </div>
    </header>
  );
}

const BranchCard = memo(function BranchCard({
  threadId,
  reviewKey,
  branch,
  forge,
  last,
  pushBlocked,
  behind,
  targetHead,
  native,
  outcome,
  running,
  busy,
  dispatch,
  readOnly,
  expanded,
  now,
  onToggleCommit,
}: {
  threadId: string;
  /** The branch's Change, for the jump from a commit's file to the review page. */
  reviewKey: ChangeKey | null;
  branch: Branch;
  /** The pull request, for the thread's own branch only. */
  forge: ForgeValue | undefined;
  /** The bottom branch of its stack: its last segment runs on to the base. */
  last: boolean;
  pushBlocked: boolean;
  behind: number;
  targetHead: string | null;
  native: boolean;
  outcome: Outcome | undefined;
  running: VcsAction["kind"] | null;
  busy: boolean;
  dispatch: Dispatch;
  /** No write buttons: the workspace is read as something it is not. */
  readOnly: boolean;
  /** The open commit's key, when it is one of this card's. */
  expanded: string | null;
  now: number;
  onToggleCommit: (key: string) => void;
}) {
  const look = BRANCH_LOOK[branch.status];
  const upstream = branch.upstreamCommits;
  return (
    <article className={CARD} aria-label={`Branch ${branch.name}`} data-testid="sc-branch">
      <CardHeader
        icon={look.icon}
        tone={look.tone}
        name={branch.name}
        trailing={
          <>
            {look.label && !forge ? (
              <Chip
                className={
                  branch.status === "conflicted"
                    ? "bg-destructive text-destructive-foreground"
                    : OUTLINE_CHIP
                }
              >
                {look.label}
              </Chip>
            ) : null}
            <ReviewChips branch={branch} forge={forge} />
          </>
        }
      />
      {readOnly ? null : (
        <BranchActions
          branch={branch}
          targetHead={targetHead}
          landable={last}
          pushBlocked={pushBlocked}
          behind={behind}
          native={native}
          outcome={outcome}
          running={running}
          busy={busy}
          dispatch={dispatch}
        />
      )}
      {/* The label carries the meaning; the amber rail repeats it. */}
      {upstream.length > 0 ? (
        <>
          <p className={cx(CARD_LABEL, "text-warning")}>
            Upstream, not in this branch <Count>{upstream.length}</Count>
          </p>
          <ul className="m-0 list-none p-0">
            {upstream.map((commit, index) => (
              <CommitRow
                key={`upstream-${commit.id}`}
                threadId={threadId}
                reviewKey={reviewKey}
                commit={commit}
                where="upstream"
                tone="upstream"
                diamond={false}
                bottom="solid"
                last={index === upstream.length - 1}
                open={expanded === commitKey("upstream", commit.id)}
                now={now}
                onToggle={onToggleCommit}
              />
            ))}
          </ul>
        </>
      ) : null}
      {branch.commits.length === 0 && upstream.length === 0 ? (
        <p className="m-0 border-t border-border-hairline px-3 py-3 text-[12px] leading-4 text-muted-foreground">
          No commits yet. Commit on this branch and they appear here.
        </p>
      ) : null}
      {upstream.length > 0 && branch.commits.length > 0 ? (
        <p className={CARD_LABEL}>
          In this branch <Count>{branch.commits.length}</Count>
        </p>
      ) : null}
      {branch.commits.length > 0 ? (
        <ul className="m-0 list-none border-t border-border-hairline p-0">
          {branch.commits.map((commit, index) => {
            const end = index === branch.commits.length - 1;
            return (
              <CommitRow
                key={commit.id}
                threadId={threadId}
                reviewKey={reviewKey}
                commit={commit}
                where="local"
                tone={look.tone}
                diamond={look.diamond}
                bottom={last && end ? "dashed" : "solid"}
                last={end && branch.moreCommits === 0}
                open={expanded === commitKey("local", commit.id)}
                now={now}
                onToggle={onToggleCommit}
              />
            );
          })}
        </ul>
      ) : null}
      {branch.moreCommits > 0 ? (
        <p className="m-0 border-t border-border-hairline ps-10 pe-3 py-2 text-[12px] leading-4 text-muted-foreground">
          {plural(branch.moreCommits, "older commit")} not shown
        </p>
      ) : null}
    </article>
  );
});

/** GitButler's link between stacked branch cards, on the rail's axis. */
export function Connector({ tone }: { tone: Tone }) {
  return <span className={cx("ms-5 block h-3 w-0.5 bg-current", TONE[tone])} aria-hidden />;
}

function holds(branch: Branch, key: string | null): boolean {
  if (key === null) return false;
  return (
    branch.commits.some((commit) => commitKey("local", commit.id) === key) ||
    branch.upstreamCommits.some((commit) => commitKey("upstream", commit.id) === key)
  );
}

/** One stack: its label, the files assigned to it, and its branches, top first. */
export const StackLane = memo(function StackLane({
  threadId,
  keyOf,
  stack,
  threadBranch,
  forge,
  behind,
  targetHead,
  native,
  outcomes,
  running,
  busy,
  dispatch,
  readOnly,
  expanded,
  now,
  onToggleCommit,
}: {
  threadId: string;
  /** Each branch's Change, or null when it has none to review. Stable across renders. */
  keyOf: (branch: Branch) => ChangeKey | null;
  stack: Stack;
  /** The thread's own branch name, whose card shows the pull request. */
  threadBranch: string | null;
  forge: ForgeValue | undefined;
  behind: number;
  targetHead: string | null;
  native: boolean;
  outcomes: ReadonlyMap<string, Outcome>;
  running: ReadonlyMap<string, VcsAction["kind"]>;
  busy: boolean;
  dispatch: Dispatch;
  readOnly: boolean;
  expanded: string | null;
  now: number;
  onToggleCommit: (key: string) => void;
}) {
  const { branches } = stack;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={`Stack ${stack.key}`}>
      <SectionLabel>Stack · {plural(branches.length, "branch", "branches")}</SectionLabel>
      {/* GitButler shows a stack's assigned changes above its branches. */}
      {stack.assigned.length > 0 ? (
        <ChangesCard
          threadId={threadId}
          title="Assigned changes"
          changes={stack.assigned}
          defaultOpen
        />
      ) : null}
      <div className="flex min-w-0 flex-col">
        {branches.map((branch, index) => {
          const last = index === branches.length - 1;
          // A push takes the branches below along, so a conflict there holds it too.
          const pushBlocked = branches
            .slice(index)
            .some((entry) => entry.commits.some((commit) => commit.conflicted));
          return (
            <div key={branch.name} className="contents">
              <BranchCard
                threadId={threadId}
                reviewKey={keyOf(branch)}
                branch={branch}
                forge={branch.name === threadBranch ? forge : undefined}
                last={last}
                pushBlocked={pushBlocked}
                behind={behind}
                targetHead={targetHead}
                native={native}
                outcome={outcomes.get(branch.name)}
                running={running.get(branch.name) ?? null}
                busy={busy}
                dispatch={dispatch}
                readOnly={readOnly}
                expanded={holds(branch, expanded) ? expanded : null}
                now={now}
                onToggleCommit={onToggleCommit}
              />
              {last ? null : <Connector tone={BRANCH_LOOK[branch.status].tone} />}
            </div>
          );
        })}
      </div>
    </section>
  );
});
