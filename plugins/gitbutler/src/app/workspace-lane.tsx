import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type {
  BaseCommit,
  Branch,
  BranchReview,
  BranchStatus,
  Commit,
  FileChange,
  PatchSource,
  ReviewState,
  Stack,
  Upstream,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { cn } from "./lib/utils.ts";
import { CommitRowsSkeleton, FileRowsSkeleton, Notice, errorText } from "./notice.tsx";
import { BASE_HISTORY_PAGE, COMMIT_QUERY } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { storedAnswer } from "./stored-queries.ts";
import { shortId, subject } from "./format.ts";
import { When } from "./when.tsx";
import { AskAgentButton, useAskAgent } from "./ask-agent.tsx";
import { BranchActions, BranchName } from "./branch-actions.tsx";
import { usePatches, usePatchesIntent } from "./file-cards.tsx";
import { ChangedFilesCard, Count, FileList, LineStats, useListMode } from "./file-list.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";

/**
 * The workspace drawn the way GitButler desktop draws a stack lane: branch
 * cards with a coloured status square, commits strung on a vertical line whose
 * colour and dot shape say where each commit lives, and file rows ending in a
 * change-kind glyph. The desktop app lays stacks side by side; a thread panel
 * is one column, so they stack vertically here.
 */

const BASE_HISTORY_MAX = 500;

/** A commit diff's source, which the hover prefetch and the open list share. */
type CommitSource = Extract<PatchSource, { kind: "commit" }>;
type CommitWhere = NonNullable<CommitSource["where"]>;

/** Anything the detail screen can be opened from: a stack, base, or history row. */
export type CommitRef = {
  commitId: string;
  /** GitButler's id for the change, kept when an amend or rebase rewrites the commit. */
  changeId?: string | null;
  createdAt: string;
  message: string;
  authorName: string;
  /** Set for a commit on the target or a branch's remote, which `but diff` cannot read. */
  where?: CommitWhere;
};

const CARD = "overflow-hidden rounded-lg border border-border bg-card";
// Inside a card: a divider and a muted label, as GitButler heads a sub-list.
const CARD_LABEL =
  "flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground";

/*
 * GitButler's commit states, in bb's palette. Text colour, not background, so
 * a solid segment (`bg-current`) and a dashed one (a `currentColor` gradient)
 * read the same class.
 */
type Tone = "local" | "remote" | "upstream" | "integrated" | "conflicted";

const TONE: Readonly<Record<Tone, string>> = {
  local: "text-muted-foreground",
  remote: "text-primary",
  upstream: "text-warning",
  integrated: "text-pr-merged",
  conflicted: "text-destructive",
};

/**
 * One row per GitButler push status. The CLI reports it per branch, not per
 * commit, so every commit on a branch takes the branch's tone.
 */
const BRANCH_LOOK: Readonly<
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

/**
 * The commit graph cell: a 2px line broken by the commit's dot. Its centre is
 * the axis every branch square and connector in the lane sits on, 20px in from
 * the card's inner edge.
 */
function Rail({
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
      className={cn("flex w-10 shrink-0 flex-col items-center gap-[3px]", TONE[tone])}
      aria-hidden
    >
      <span className="w-0.5 flex-1 bg-current" />
      <span
        className={cn(
          "size-2.5 shrink-0 bg-current",
          diamond ? "rotate-45 scale-[0.86] rounded-[2px]" : "rounded-full",
        )}
      />
      <span
        className={cn(
          "w-0.5 flex-1",
          bottom === "dashed"
            ? "bg-[linear-gradient(to_bottom,currentColor_50%,transparent_50%)] bg-size-[2px_4px]"
            : "bg-current",
        )}
      />
    </span>
  );
}

/** Which commit is open under its row, and what opening one of its files does. */
export type CommitExpansion = WorkspaceTarget & {
  /**
   * Where the commit sits, then its change id where it has one, else its
   * commit id. An upstream commit can carry the change id of the local one
   * it was rebased from, and the two rows are separate commits.
   */
  expanded: string | null;
  onToggle: (key: string) => void;
  onOpenFile: (commit: CommitRef, path: string) => void;
};

/*
 * Every commit row in the panel opens in place, as GitButler's do, and only
 * one at a time. A context, so the stack, base, and history cards need not
 * thread it through.
 */
export const CommitExpansionContext = createContext<CommitExpansion | null>(null);

function CommitRow({
  commit,
  where,
  tone,
  diamond,
  bottom,
  last,
  meta,
}: {
  commit: CommitRef & { conflicted?: boolean };
  /** Where a commit off the workspace sits, so its diff goes straight to git. */
  where?: CommitWhere;
  tone: Tone;
  diamond: boolean;
  bottom?: Segment;
  last: boolean;
  meta?: ReactNode;
}) {
  const expansion = useContext(CommitExpansionContext)!;
  // By change id, so an open commit stays open when GitButler rewrites it.
  const key = `${where ?? "local"}:${commit.changeId ?? commit.commitId}`;
  const open = expansion.expanded === key;
  const title = subject(commit.message);
  const railTone = commit.conflicted ? "conflicted" : tone;
  // One source for the prefetch and the list, so a click finds what the hover fetched.
  const source = useMemo<CommitSource>(
    () => ({ kind: "commit", commitId: commit.commitId, ...(where ? { where } : {}) }),
    [commit.commitId, where],
  );
  const intent = usePatchesIntent(expansion.threadId, expansion.repositoryKey, source);
  return (
    <li>
      <button
        type="button"
        className={cn(
          // The card clips outside the row, so the focus outline is drawn inside it.
          "relative flex w-full min-w-0 cursor-pointer items-stretch text-start hover:bg-state-hover focus-visible:-outline-offset-2",
          commit.conflicted && "bg-surface-destructive",
        )}
        onClick={() => expansion.onToggle(key)}
        {...(open ? {} : intent)}
        aria-expanded={open}
        title={`${shortId(commit.commitId)} ${title}`}
      >
        {/* GitButler's marker for the open commit, on the card's edge. */}
        {open ? (
          <span
            className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary"
            aria-hidden
          />
        ) : null}
        <Rail tone={railTone} diamond={diamond} bottom={bottom} />
        {/* The rule stops at the rail, so the graph line never breaks. */}
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-2 pe-2.5",
            !last && !open && "border-b border-border",
          )}
        >
          {commit.conflicted ? (
            <Icon
              name="AlertTriangle"
              className="size-3.5 shrink-0 text-destructive-text"
              aria-label="Conflicted"
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              commit.conflicted && "text-destructive-text",
              !title && "font-normal italic text-muted-foreground",
            )}
          >
            {title || "No commit message"}
          </span>
          <span className="flex shrink-0 gap-1.5 text-[11px] tabular-nums text-muted-foreground">
            {meta}
            {/* Rewrites itself as the panel ticks, so tabular digits stop the row twitching. */}
            <When value={commit.createdAt} />
          </span>
        </span>
      </button>
      {open ? (
        <div className="relative px-2.5 pt-0.5 pb-2.5">
          {/* The rail runs on behind the card, so the graph reads unbroken. */}
          <span
            className={cn(
              "absolute inset-y-0 left-[19px] w-0.5",
              TONE[railTone],
              bottom === "dashed"
                ? "bg-[linear-gradient(to_bottom,currentColor_50%,transparent_50%)] bg-size-[2px_4px]"
                : "bg-current",
            )}
            aria-hidden
          />
          {/* Opaque: bb's card fill is translucent, and the rail would show through. */}
          <div className="relative rounded-lg bg-background">
            <CommitFiles commit={commit} source={source} expansion={expansion} />
          </div>
        </div>
      ) : null}
      {open && !last ? <div className="ms-10 border-b border-border" /> : null}
    </li>
  );
}

/** A commit's changed files, under its row. */
function CommitFiles({
  commit,
  source,
  expansion,
}: {
  commit: CommitRef;
  source: CommitSource;
  expansion: CommitExpansion;
}) {
  // The row outlives an amend or rebase of its change, so the list it showed
  // is that change's earlier diff. It stays up, dimmed, until the new one lands.
  const { patches, changes, totals, truncated } = usePatches(
    expansion.threadId,
    expansion.repositoryKey,
    source,
    { keepPrevious: true },
  );
  if (patches.isPending) return <FileRowsSkeleton label="Loading changes…" rows={3} />;
  // `flow-root` keeps the message's margins inside the filled box.
  if (patches.isError) {
    return (
      <div className="flow-root px-2.5">
        <Notice
          title="Changes failed to load"
          detail={errorText(patches.error)}
          onRetry={() => void patches.refetch()}
        />
      </div>
    );
  }
  return (
    <div
      className={cn("transition-opacity", patches.isPlaceholderData && "opacity-70")}
      aria-busy={patches.isPlaceholderData}
    >
      <ChangesCard
        title="Changed files"
        changes={changes}
        stats={truncated ? null : <LineStats added={totals.added} removed={totals.removed} />}
        defaultOpen
        onOpenFile={(path) => expansion.onOpenFile({ ...commit, where: source.where }, path)}
      />
    </div>
  );
}

/** A card of changed files, as GitButler heads its file lists. */
function ChangesCard({
  title,
  changes,
  stats,
  defaultOpen,
  attention,
  actions,
  onOpenFile,
}: {
  title: string;
  changes: readonly FileChange[];
  stats?: ReactNode;
  defaultOpen: boolean;
  attention?: boolean;
  actions?: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode] = useListMode();
  return (
    <ChangedFilesCard
      title={title}
      count={changes.length}
      stats={stats}
      open={open}
      onToggle={() => setOpen((current) => !current)}
      attention={attention}
      actions={actions}
    >
      <FileList changes={changes} mode={mode} onSelect={onOpenFile} />
    </ChangedFilesCard>
  );
}

// A busy worktree would bury the request under its own file list.
const QUOTED_PATHS_MAX = 20;

/** What the reader asks the agent when a turn left files uncommitted. */
function commitRequest(changes: readonly FileChange[]): string {
  const paths = changes.slice(0, QUOTED_PATHS_MAX).map((change) => change.path);
  const rest = changes.length - paths.length;
  const list = rest > 0 ? `${paths.join(", ")} and ${rest} more` : paths.join(", ");
  return changes.length === 1
    ? `This file is uncommitted: ${list}. Commit it to the right branch with but.`
    : `These ${changes.length} files are uncommitted: ${list}. Commit them to the right branch with but.`;
}

/**
 * Closed by default: a busy worktree is dozens of rows, and the stacks are
 * what the panel is for. Work an agent's turn left behind is the exception
 * worth a look, so the header says so and offers to hand it back.
 */
export function UncommittedCard({
  changes,
  onOpenFile,
  attention = false,
}: {
  changes: readonly FileChange[];
  onOpenFile: (path: string) => void;
  /** The last turn ended with these files still uncommitted. */
  attention?: boolean;
}) {
  const ask = useAskAgent();
  const flagged = attention && changes.length > 0;
  return (
    <ChangesCard
      title="Uncommitted changes"
      changes={changes}
      defaultOpen={false}
      attention={flagged}
      actions={
        flagged && ask ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 gap-1 px-2 text-xs font-normal"
            onClick={() => ask(commitRequest(changes))}
          >
            <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
            Ask agent to commit
          </Button>
        ) : null
      }
      onOpenFile={onOpenFile}
    />
  );
}

/** A card's header: status square and name, then an optional line of detail. */
function CardHeader({
  icon,
  tone,
  heading,
  details,
  trailing,
}: {
  icon: string;
  tone: Tone;
  heading: ReactNode;
  details?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-1.5 px-2.5 py-2">
      {/*
       * The chips once shared one line with the name at any width, and on a
       * narrow panel they squeezed it to a few letters. The name keeps room
       * to be read, and the chips wrap to a line of their own when it runs out.
       */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex min-w-0 flex-[1_1_10rem] items-center gap-2">
          {/* The square's centre sits on the commit rail's axis below it. */}
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-md",
              TONE[tone],
              "bg-current",
            )}
            aria-hidden
          >
            <Icon name={icon} className="size-3.5 text-background" />
          </span>
          {heading}
        </div>
        {trailing ? (
          <div className="ms-auto flex flex-wrap items-center justify-end gap-1.5">{trailing}</div>
        ) : null}
      </div>
      {details ? (
        <p className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
          {details}
        </p>
      ) : null}
    </header>
  );
}

const CHIP =
  "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full bg-secondary px-1.5 text-[11px] font-semibold whitespace-nowrap text-secondary-foreground";

/** A small pill beside the branch name, so status costs no row of its own. */
function Chip({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn(CHIP, className)} title={title}>
      {children}
    </span>
  );
}

/**
 * The review's checks overall, in bb's feedback colours. Said in words too:
 * an icon alone left the reader to guess what the green tick was about.
 */
const CI_LOOK: Readonly<
  Record<NonNullable<Branch["ci"]>, { icon: string; tone: string; label: string }>
> = {
  success: { icon: "CircleCheck", tone: "text-success", label: "Checks passing" },
  failure: { icon: "CircleX", tone: "text-destructive-text", label: "Checks failing" },
  pending: { icon: "Clock", tone: "text-warning-text", label: "Checks running" },
};

const OUTLINE_CHIP = "bg-transparent ring-1 ring-border ring-inset";

/**
 * The checks chip. Failing checks are a job for the agent, so that chip asks
 * it to find and fix them. The panel itself never pushes a fix. Its name and
 * the ask icon say so, since a title is out of reach on touch and to a
 * screen reader.
 */
function ChecksChip({ branch, review }: { branch: Branch; review: string | null }) {
  const ask = useAskAgent();
  if (!branch.ci) return null;
  const look = CI_LOOK[branch.ci];
  const content = (
    <>
      <Icon name={look.icon} className="size-3" aria-hidden />
      {look.label}
    </>
  );
  if (branch.ci !== "failure" || !ask) {
    return <Chip className={cn(OUTLINE_CHIP, look.tone)}>{content}</Chip>;
  }
  return (
    <button
      type="button"
      className={cn(
        CHIP,
        OUTLINE_CHIP,
        look.tone,
        "cursor-pointer hover:bg-state-hover",
        CONTROL_HOVER_TRANSITION,
      )}
      aria-label={`${look.label} on ${branch.name}: ask agent to fix them`}
      title="Ask the agent to find the failing check and fix it"
      onClick={() =>
        ask(
          `Checks are failing on branch ${branch.name}${review ? ` (PR ${review})` : ""}. Find the failing check and fix it.`,
        )
      }
    >
      {content}
      <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
    </button>
  );
}

/** How often review states are read again. The read can ask the forge, so not on the board's poll. */
const REVIEWS_POLL_MS = 60_000;

/** A branch's review, from the one read every card of the repository shares. */
function useBranchReview(target: WorkspaceTarget, branch: string): BranchReview | null {
  const reviews = rpc.reviews.useQuery(target, {
    staleTime: REVIEWS_POLL_MS,
    refetchInterval: REVIEWS_POLL_MS,
  });
  return reviews.data?.reviews.find((review) => review.branch === branch) ?? null;
}

const REVIEW_LOOK: Readonly<Record<ReviewState, { label: string; icon: string; tone: string }>> = {
  open: { label: "Open", icon: "GitPullRequest", tone: "text-success" },
  draft: { label: "Draft", icon: "GitPullRequestDraft", tone: "text-subtle-foreground" },
  merged: { label: "Merged", icon: "GitMerge", tone: "text-pr-merged" },
  closed: { label: "Closed", icon: "GitPullRequestClosed", tone: "text-destructive-text" },
};

/**
 * The PR chip: where the review stands, and a link to it. A link the review
 * read already has opens at once. Without one, a click asks `but` for it.
 */
function ReviewChip({
  id,
  state,
  url,
  link,
}: {
  /** The forge's own form, "#42" or "!42". */
  id: string;
  /** Null until the review read says, or when it cannot. */
  state: ReviewState | null;
  url: string | null;
  link: ReturnType<typeof useReviewLink>;
}) {
  const look = state ? REVIEW_LOOK[state] : null;
  const opening = url === null && link.opening;
  const content = (
    <>
      <Icon
        name={opening ? "Spinner" : (look?.icon ?? "GitPullRequest")}
        className={cn("size-3", look?.tone, opening && "animate-spin")}
        aria-hidden
      />
      {look ? `${look.label} ${id}` : `PR ${id}`}
    </>
  );
  const className = cn(CHIP, "cursor-pointer hover:bg-secondary/80");
  if (url) {
    return (
      <UrlLink href={url} className={className} title={`Open PR ${id}`}>
        {content}
      </UrlLink>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={`Open PR ${id}`}
      aria-busy={opening}
      onClick={() => void link.open()}
    >
      {content}
    </button>
  );
}

/**
 * Opens a branch's review on its forge. `but` asks the forge for the link,
 * so it is looked up when the chip is clicked, never on a poll.
 */
function useReviewLink(target: WorkspaceTarget, branch: string) {
  const navigate = useBbNavigate();
  const link = rpc.reviewUrl.useQuery({ ...target, branch }, { enabled: false });
  // This card's last click, not the shared cache: a lookup that failed before
  // the panel remounted is not news to a reader who has not clicked since.
  const [problem, setProblem] = useState<string | null>(null);
  return {
    open: async () => {
      setProblem(null);
      const result = await link.refetch();
      if (result.isError) setProblem(errorText(result.error));
      else if (result.data?.url) navigate.openUrl(result.data.url);
      else setProblem("GitButler could not find this PR on its forge.");
    },
    opening: link.isFetching,
    problem,
  };
}

/** What the agent is told about a branch when asked about it, e.g. "Branch x: 2 commits, pushed, PR #42". */
function branchQuote(branch: Branch, status: string, review: string | null): string {
  const commits = `${branch.commits.length} ${branch.commits.length === 1 ? "commit" : "commits"}`;
  const facts = [commits, status.toLowerCase() || branch.rawStatus, review ? `PR ${review}` : ""];
  return `Branch ${branch.name}: ${facts.filter(Boolean).join(", ")}`;
}

function BranchCard({
  target,
  branch,
  last,
  pushedWith,
  branchesAbove,
  behind,
}: {
  target: WorkspaceTarget;
  branch: Branch;
  /** The bottom branch of its stack: its last segment runs on to the base. */
  last: boolean;
  /** This branch and every branch below it, which `but push` forces along. */
  pushedWith: readonly Branch[];
  /** Branches stacked on this one. */
  branchesAbove: number;
  /** Commits the target has that the workspace lacks, which Land pulls first. */
  behind: number;
}) {
  const look = BRANCH_LOOK[branch.status];
  const review = useReviewLink(target, branch.name);
  const forge = useBranchReview(target, branch.name);
  const reviewId = branch.reviewId ?? (forge ? `#${forge.number}` : null);
  // `but` 0.22.3 lists open reviews only, so a merge shows as the branch
  // being integrated into the target.
  const reviewState = branch.status === "integrated" ? "merged" : (forge?.state ?? null);
  const upstream = branch.upstreamCommits;
  return (
    <article className={CARD} aria-label={`Branch ${branch.name}`}>
      <CardHeader
        icon={look.icon}
        tone={look.tone}
        // Unkeyed: the card is keyed by its identity, which a rename keeps.
        heading={<BranchName target={target} name={branch.name} />}
        details={
          review.problem ? (
            <span role="alert" className="truncate text-destructive-text" title={review.problem}>
              {review.problem}
            </span>
          ) : null
        }
        trailing={
          <>
            {look.label ? (
              <Chip
                title={branch.rawStatus}
                className={
                  branch.status === "conflicted"
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-transparent font-medium text-muted-foreground ring-1 ring-border ring-inset"
                }
              >
                {look.label}
              </Chip>
            ) : null}
            {reviewId ? (
              <ReviewChip
                id={reviewId}
                state={reviewState}
                url={forge?.url ?? null}
                link={review}
              />
            ) : null}
            <ChecksChip branch={branch} review={reviewId} />
            <AskAgentButton
              text={branchQuote(branch, look.label, reviewId)}
              label={`Ask agent about ${branch.name}`}
            />
          </>
        }
      />
      <BranchActions
        target={target}
        // A PR the review read found and status did not still rules out Create PR.
        branch={reviewId === branch.reviewId ? branch : { ...branch, reviewId }}
        landable={last}
        pushedWith={pushedWith}
        branchesAbove={branchesAbove}
        behind={behind}
      />
      {/*
       * Upstream commits were once told apart from local ones by colour alone,
       * which says nothing to anyone who cannot separate the two hues. The
       * label carries the meaning; the amber rail repeats it.
       */}
      {upstream.length > 0 ? (
        <>
          <p className={cn(CARD_LABEL, "text-warning-text")}>
            Upstream, not in this branch <Count>{upstream.length}</Count>
          </p>
          <ul className="list-none">
            {upstream.map((commit, index) => (
              <CommitRow
                key={`upstream-${commit.changeId ?? commit.commitId}`}
                commit={commit}
                where="upstream"
                tone="upstream"
                diamond={false}
                last={index === upstream.length - 1}
              />
            ))}
          </ul>
        </>
      ) : null}
      {branch.commits.length === 0 && upstream.length === 0 ? (
        <p className="border-t border-border px-2.5 py-2 italic text-muted-foreground">
          No commits yet. Commit on this branch and they appear here.
        </p>
      ) : null}
      {/* Only needed opposite an upstream label; alone the list is obvious. */}
      {upstream.length > 0 && branch.commits.length > 0 ? (
        <p className={CARD_LABEL}>
          In this branch <Count>{branch.commits.length}</Count>
        </p>
      ) : null}
      {branch.commits.length > 0 ? (
        <ul className="list-none border-t border-border">
          {branch.commits.map((commit, index) => {
            const end = index === branch.commits.length - 1;
            return (
              <CommitRow
                // By change id, so an amend or rebase redraws the row in place.
                key={commit.changeId ?? commit.commitId}
                commit={commit}
                tone={look.tone}
                diamond={look.diamond}
                bottom={last && end ? "dashed" : "solid"}
                last={end}
              />
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

/** GitButler's link between stacked branch cards, on the rail's axis. */
function Connector({ tone }: { tone: Tone }) {
  return <span className={cn("ms-5 block h-3 w-0.5 bg-current", TONE[tone])} aria-hidden />;
}

/**
 * React keys that keep a card's identity across renames: each item's oldest
 * commit change id, which a rename, amend or rebase keeps. An item with no
 * change id, or one sharing it with a sibling, as a copied commit can, has
 * only its name, so one card's state never passes to another.
 */
function identityKeys<T>(
  items: T[],
  commits: (item: T) => Commit[],
  name: (item: T) => string,
): string[] {
  const ids = items.map((item) => commits(item).findLast((commit) => commit.changeId)?.changeId);
  const counts = new Map<string, number>();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return items.map((item, index) => {
    const id = ids[index];
    return id && counts.get(id) === 1 ? `change:${id}` : `name:${name(item)}`;
  });
}

/**
 * The stacks' keys. A stack keeps its oldest commit when its bottom branch is
 * renamed, while `but` names the stack after that branch. Redrawing the whole
 * stack would take the focus from wherever the reader had moved it in there.
 */
export function stackKeys(stacks: Stack[]): string[] {
  return identityKeys(
    stacks,
    (stack) => stack.branches.flatMap((branch) => branch.commits),
    (stack) => stack.key,
  );
}

export function StackLane({
  target,
  stack,
  behind,
  onOpenFile,
}: {
  target: WorkspaceTarget;
  stack: Stack;
  /** Commits the target has that the workspace lacks, as GitButler last fetched it. */
  behind: number;
  /** Opens one of the stack's assigned files. */
  onOpenFile: (path: string) => void;
}) {
  const branchKeys = identityKeys(
    stack.branches,
    (branch) => branch.commits,
    (branch) => branch.name,
  );
  return (
    <section className="flex flex-col" aria-label={`Stack ${stack.key}`}>
      {/* GitButler shows a stack's assigned changes above its branches. */}
      {stack.assignedChanges.length > 0 ? (
        <div className="mb-2">
          <ChangesCard
            title="Assigned changes"
            changes={stack.assignedChanges}
            defaultOpen
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}
      {stack.branches.map((branch, index) => {
        const last = index === stack.branches.length - 1;
        return (
          // Keyed by identity, so a rename keeps the card and its open lists.
          <div key={branchKeys[index]} className="contents">
            <BranchCard
              target={target}
              branch={branch}
              last={last}
              // Top first, so a branch's ancestors are the ones after it.
              pushedWith={stack.branches.slice(index)}
              branchesAbove={index}
              behind={behind}
            />
            {last ? null : <Connector tone={BRANCH_LOOK[branch.status].tone} />}
          </div>
        );
      })}
    </section>
  );
}

/**
 * How many commits of a base's history to show. The window belongs to the
 * base it was opened on. A new base is a different history, so it starts
 * over at one page without an effect.
 */
function useHistoryWindow(from: string) {
  const [page, setPage] = useState({ from, limit: BASE_HISTORY_PAGE });
  const limit = page.from === from ? page.limit : BASE_HISTORY_PAGE;
  const grow = () =>
    setPage({ from, limit: Math.min(BASE_HISTORY_MAX, limit + BASE_HISTORY_PAGE) });
  return { limit, grow };
}

/**
 * The target branch below the workspace, as GitButler draws its target: a
 * card of pushed commits, the common base on top and older history under it.
 */
export function BaseCard({
  threadId,
  repositoryKey,
  base,
  upstream = null,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  base: BaseCommit;
  /** The target's fetch state, for when the history below was last brought in. */
  upstream?: Upstream | null;
}) {
  const { limit, grow } = useHistoryWindow(base.commitId);

  const input = { threadId, repositoryKey, from: base.commitId, offset: 0, limit };
  const history = rpc.baseHistory.useQuery(input, {
    ...storedAnswer("baseHistory", input),
    // History under a commit id never changes, so it is read once per base.
    ...COMMIT_QUERY,
    // A bigger page is a new key. Keep the list the reader was looking at
    // until the longer one lands, instead of swapping it for a spinner. Not
    // a list under another base, which a pull or a switch leaves behind:
    // drawn under this one, its commits would read as this base's history.
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[1] as { from?: string } | undefined)?.from === base.commitId
        ? previous
        : undefined,
  });
  const commits = history.data?.reason ? [] : (history.data?.commits ?? []);
  const more = Boolean(history.data?.hasMore) && limit < BASE_HISTORY_MAX;
  const loadingMore = history.isFetching && history.isPlaceholderData;
  const fetched = upstream?.lastFetched;

  return (
    <article className={CARD} aria-label="Common base">
      <CardHeader
        icon="Target"
        tone="remote"
        heading={<h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">Common base</h3>}
        details={
          <>
            <span className="truncate">Where the applied branches meet the target</span>
            {fetched ? (
              <span className="shrink-0">
                · fetched <When value={fetched} />
              </span>
            ) : null}
          </>
        }
      />
      <ul className="list-none border-t border-border">
        <CommitRow
          commit={base}
          where="base"
          tone="remote"
          diamond
          bottom={commits.length > 0 ? "solid" : "dashed"}
          // A labelled section always follows, and its label draws the rule.
          last
          meta={<span className="max-w-24 truncate">{base.authorName}</span>}
        />
      </ul>
      {/* The list below carried no label once, so it read as commits from nowhere. */}
      <p className={CARD_LABEL}>Before the common base</p>
      {history.isPending ? (
        <CommitRowsSkeleton label="Loading history…" rows={4} />
      ) : history.isError || history.data.reason ? (
        <div className="px-2.5">
          <Notice
            title={history.isError ? "History failed to load" : "History unavailable"}
            detail={history.isError ? errorText(history.error) : history.data.reason}
            onRetry={() => void history.refetch()}
          />
        </div>
      ) : (
        <ul className="list-none border-t border-border">
          {commits.map((commit, index) => (
            <CommitRow
              key={commit.commitId}
              commit={commit}
              where="base"
              tone="remote"
              diamond
              bottom={index === commits.length - 1 ? "dashed" : "solid"}
              last={index === commits.length - 1}
              meta={<span className="max-w-24 truncate">{commit.authorName}</span>}
            />
          ))}
        </ul>
      )}
      {more ? <LoadMore disabled={history.isFetching} loading={loadingMore} onLoad={grow} /> : null}
    </article>
  );
}

/** The base history's footer. The spinner says a longer page is on its way. */
function LoadMore({
  disabled,
  loading,
  onLoad,
}: {
  disabled: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  return (
    <footer className="border-t border-border bg-secondary/40 px-2.5 py-2">
      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1 px-2.5 text-xs font-normal"
        disabled={disabled}
        aria-busy={loading}
        onClick={onLoad}
      >
        {loading ? <Icon name="Spinner" className="size-3 animate-spin" aria-hidden /> : null}
        {/* Names what is hidden without claiming a count the CLI has not sent. */}
        Load more commits
      </Button>
    </footer>
  );
}
