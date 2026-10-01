import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { keepPreviousData } from "@tanstack/react-query";
import { SVGSpriteSheet } from "@pierre/diffs";
import type {
  BaseCommit,
  Branch,
  BranchStatus,
  ChangeKind,
  Commit,
  FileChange,
  Stack,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import { rpc, defined } from "./rpc.ts";
import { relativeTime, shortId, subject } from "./format.ts";
import { BranchActions, BranchName } from "./branch-actions.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";

/**
 * The workspace drawn the way GitButler desktop draws a stack lane: branch
 * cards with a coloured status square, commits strung on a vertical line whose
 * colour and dot shape say where each commit lives, and file rows ending in a
 * change-kind glyph. The desktop app lays stacks side by side; a thread panel
 * is one column, so they stack vertically here.
 */

const REFRESH_INTERVAL_MS = 10_000;
const BASE_HISTORY_PAGE = 60;
const BASE_HISTORY_MAX = 500;

/** Anything the detail screen can be opened from: a stack, base, or history row. */
export type CommitRef = { commitId: string; createdAt: string; message: string };

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
  diverged: { tone: "remote", icon: "ArrowUpDown", label: "Diverged", diamond: false },
  integrated: { tone: "integrated", icon: "GitMerge", label: "Integrated", diamond: false },
  conflicted: { tone: "conflicted", icon: "AlertTriangle", label: "Conflicted", diamond: false },
  empty: { tone: "local", icon: "GitBranch", label: "Empty", diamond: false },
  unknown: { tone: "local", icon: "GitBranch", label: "", diamond: false },
};

/*
 * Pierre's change-kind artwork, the same sprite `plugins/monokai` puts on bb's
 * diff headers, so a file reads the same here and in the diff it opens to.
 */
const FILE_LOOK: Readonly<Record<ChangeKind, { label: string; tone: string; symbol: string }>> = {
  added: { label: "Added", tone: "text-diff-added", symbol: "added" },
  modified: {
    label: "Modified",
    tone: "text-[var(--diffs-modified-color-override,var(--warning))]",
    symbol: "modified",
  },
  deleted: { label: "Deleted", tone: "text-diff-removed", symbol: "deleted" },
  renamed: { label: "Renamed", tone: "text-pr-merged", symbol: "moved" },
  copied: { label: "Copied", tone: "text-pr-merged", symbol: "moved" },
};

/** Each symbol's path data, read once from the sprite. */
const SPRITE_PATHS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ...SVGSpriteSheet.matchAll(
      /<symbol id="diffs-icon-symbol-([\w-]+)"[^>]*>([\s\S]*?)<\/symbol>/g,
    ),
  ].map(([, name, body]) => [name!, [...body!.matchAll(/ d="([^"]+)"/g)].map(([, d]) => d!)]),
);

/** GitButler's solid count pill. */
function Count({ children }: { children: number }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[10px] font-semibold tabular-nums text-secondary-foreground">
      {children}
    </span>
  );
}

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

function CommitRow({
  commit,
  tone,
  diamond,
  bottom,
  last,
  meta,
  onOpen,
}: {
  commit: CommitRef & { conflicted?: boolean };
  tone: Tone;
  diamond: boolean;
  bottom?: Segment;
  last: boolean;
  meta?: ReactNode;
  onOpen: () => void;
}) {
  const title = subject(commit.message);
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-stretch text-start hover:bg-state-hover",
          commit.conflicted && "bg-destructive/10",
        )}
        onClick={onOpen}
        title={`${shortId(commit.commitId)} ${title}`}
      >
        <Rail tone={commit.conflicted ? "conflicted" : tone} diamond={diamond} bottom={bottom} />
        {/* The rule stops at the rail, so the graph line never breaks. */}
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-2 pe-2.5",
            !last && "border-b border-border",
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
            {/* Rewrites itself on every refresh, so tabular digits stop the row twitching. */}
            <span>{relativeTime(commit.createdAt)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function FileStatus({ kind }: { kind: ChangeKind }) {
  const look = FILE_LOOK[kind];
  return (
    <>
      <svg
        viewBox="0 0 16 16"
        className={cn("size-3.5 shrink-0", look.tone)}
        fill="currentColor"
        aria-hidden
      >
        {SPRITE_PATHS.get(look.symbol)?.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <span className="sr-only">{look.label}</span>
    </>
  );
}

function FileRow({ change, onOpen }: { change: FileChange; onOpen: () => void }) {
  const separator = change.path.lastIndexOf("/");
  return (
    <li className="border-t border-border-hairline">
      <button
        type="button"
        className="flex h-7.5 w-full min-w-0 items-center gap-2 ps-3.5 pe-2.5 text-start hover:bg-state-hover"
        onClick={onOpen}
        title={change.path}
      >
        <Icon name="File" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {/*
         * Directory first, as GitButler lists it, and it gives way before the
         * filename does. No `direction: rtl`: it reorders leading punctuation,
         * so `.bb/` renders as `bb./`.
         */}
        <span className="flex min-w-0 flex-1 items-baseline">
          {separator > 0 ? (
            <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
              {change.path.slice(0, separator + 1)}
            </span>
          ) : null}
          <span className="max-w-full shrink-0 truncate font-semibold">
            {change.path.slice(separator + 1)}
          </span>
        </span>
        <FileStatus kind={change.kind} />
      </button>
    </li>
  );
}

/** A card of changed files under a foldable header, as GitButler heads its file lists. */
function ChangesCard({
  title,
  changes,
  defaultOpen,
  onOpenFile,
}: {
  title: string;
  changes: readonly FileChange[];
  defaultOpen: boolean;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  const empty = changes.length === 0;
  return (
    <section className={CARD} aria-label={title}>
      <button
        type="button"
        className="flex h-9 w-full min-w-0 items-center gap-2 px-2.5 text-start enabled:hover:bg-state-hover"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open && !empty}
        aria-controls={listId}
        disabled={empty}
      >
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90",
            empty && "invisible",
          )}
          aria-hidden
        />
        <span className="truncate text-[13px] font-semibold">{title}</span>
        <Count>{changes.length}</Count>
      </button>
      <ul id={listId} className="list-none" hidden={!open || empty}>
        {open
          ? changes.map((change) => (
              <FileRow key={change.path} change={change} onOpen={() => onOpenFile(change.path)} />
            ))
          : null}
      </ul>
    </section>
  );
}

/**
 * Closed by default: a busy worktree is dozens of rows, and the stacks are
 * what the panel is for.
 */
export function UncommittedCard({
  changes,
  onOpenFile,
}: {
  changes: readonly FileChange[];
  onOpenFile: (path: string) => void;
}) {
  return (
    <ChangesCard
      title="Uncommitted changes"
      changes={changes}
      defaultOpen={false}
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
      <div className="flex min-w-0 items-center gap-2">
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
        {trailing}
      </div>
      {details ? (
        <p className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
          {details}
        </p>
      ) : null}
    </header>
  );
}

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
    <span
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full bg-secondary px-1.5 text-[11px] font-semibold whitespace-nowrap text-secondary-foreground",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

function BranchCard({
  target,
  branch,
  last,
  onOpenCommit,
}: {
  target: WorkspaceTarget;
  branch: Branch;
  /** The bottom branch of its stack: its last segment runs on to the base. */
  last: boolean;
  onOpenCommit: (commit: Commit) => void;
}) {
  const look = BRANCH_LOOK[branch.status];
  const upstream = branch.upstreamCommits;
  return (
    <article className={CARD} aria-label={`Branch ${branch.name}`}>
      <CardHeader
        icon={look.icon}
        tone={look.tone}
        heading={<BranchName key={branch.name} target={target} name={branch.name} />}
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
            {branch.reviewId ? (
              <Chip>
                <Icon name="GitPullRequest" className="size-3" aria-hidden />
                {`PR #${branch.reviewId}`}
              </Chip>
            ) : null}
          </>
        }
      />
      <BranchActions target={target} branch={branch} landable={last} />
      {/*
       * Upstream commits were once told apart from local ones by colour alone,
       * which says nothing to anyone who cannot separate the two hues. The
       * label carries the meaning; the amber rail repeats it.
       */}
      {upstream.length > 0 ? (
        <>
          <p className={cn(CARD_LABEL, "text-warning")}>
            Upstream, not in this branch <Count>{upstream.length}</Count>
          </p>
          <ul className="list-none">
            {upstream.map((commit, index) => (
              <CommitRow
                key={`upstream-${commit.commitId}`}
                commit={commit}
                tone="upstream"
                diamond={false}
                last={index === upstream.length - 1}
                onOpen={() => onOpenCommit(commit)}
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
        <p className={CARD_LABEL}>In this branch</p>
      ) : null}
      {branch.commits.length > 0 ? (
        <ul className="list-none border-t border-border">
          {branch.commits.map((commit, index) => {
            const end = index === branch.commits.length - 1;
            return (
              <CommitRow
                key={commit.commitId}
                commit={commit}
                tone={look.tone}
                diamond={look.diamond}
                bottom={last && end ? "dashed" : "solid"}
                last={end}
                onOpen={() => onOpenCommit(commit)}
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

export function StackLane({
  target,
  stack,
  onOpenCommit,
  onOpenFile,
}: {
  target: WorkspaceTarget;
  stack: Stack;
  onOpenCommit: (commit: Commit) => void;
  onOpenFile: (path: string) => void;
}) {
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
          <div key={branch.name} className="contents">
            <BranchCard target={target} branch={branch} last={last} onOpenCommit={onOpenCommit} />
            {last ? null : <Connector tone={BRANCH_LOOK[branch.status].tone} />}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The target branch below the workspace, as GitButler draws its target: a
 * card of pushed commits, the common base on top and older history under it.
 */
export function BaseCard({
  threadId,
  repositoryKey,
  base,
  onOpenCommit,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  base: BaseCommit;
  onOpenCommit: (commit: CommitRef) => void;
}) {
  const [limit, setLimit] = useState(BASE_HISTORY_PAGE);
  // A new base means a different history; start the window over.
  useEffect(() => setLimit(BASE_HISTORY_PAGE), [base.commitId]);

  const history = rpc.baseHistory.useQuery(
    defined({ threadId, repositoryKey, from: base.commitId, offset: 0, limit }),
    // A bigger page is a new key. Keep the list the reader was looking at
    // until the longer one lands, instead of swapping it for a spinner.
    { staleTime: REFRESH_INTERVAL_MS, placeholderData: keepPreviousData },
  );
  const commits = history.data?.reason ? [] : (history.data?.commits ?? []);
  const more = Boolean(history.data?.hasMore) && limit < BASE_HISTORY_MAX;

  return (
    <article className={CARD} aria-label="Common base">
      <CardHeader
        icon="Target"
        tone="remote"
        heading={
          <h3 className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold">Common base</h3>
        }
        details={<span>Where the applied branches meet the target</span>}
      />
      <ul className="list-none border-t border-border">
        <CommitRow
          commit={base}
          tone="remote"
          diamond
          bottom={commits.length > 0 ? "solid" : "dashed"}
          last={commits.length === 0}
          meta={<span>{base.authorName}</span>}
          onOpen={() => onOpenCommit(base)}
        />
      </ul>
      {/* The list below carried no label once, so it read as commits from nowhere. */}
      <p className={CARD_LABEL}>Before the common base</p>
      {history.isPending ? (
        <div className="px-2.5">
          <Loading label="Loading history…" />
        </div>
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
              tone="remote"
              diamond
              bottom={index === commits.length - 1 ? "dashed" : "solid"}
              last={index === commits.length - 1}
              meta={<span className="max-w-24 truncate">{commit.authorName}</span>}
              onOpen={() => onOpenCommit(commit)}
            />
          ))}
        </ul>
      )}
      {more ? (
        <footer className="border-t border-border bg-secondary/40 px-2.5 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2.5 text-xs font-normal"
            disabled={history.isFetching}
            onClick={() =>
              setLimit((current) => Math.min(BASE_HISTORY_MAX, current + BASE_HISTORY_PAGE))
            }
          >
            {/* Names what is hidden without claiming a count the CLI has not sent. */}
            Load more commits
          </Button>
        </footer>
      ) : null}
    </article>
  );
}
