import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, useBbContext } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import type {
  BaseCommit,
  BranchStatus,
  Commit,
  FileChange,
  PatchSource,
  Repository,
  Stack,
  Workspace,
} from "../shared/schema.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import { FileCards } from "./file-cards.tsx";
import { rpc, defined } from "./rpc.ts";
import { BRANCH_STATUS_LABEL, changeSymbol, relativeTime, shortId, subject } from "./format.ts";
import "./gitbutler.css";

const REFRESH_INTERVAL_MS = 10_000;
const BASE_HISTORY_PAGE = 60;
const BASE_HISTORY_MAX = 500;
const REPOSITORY_STORAGE_PREFIX = "bb-plugin-gitbutler:repository:";

const SHELL = "flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground text-xs";
const SCROLL = "min-h-0 flex-1 overflow-auto px-2.5 pb-6 pt-2";
const ROW =
  "flex min-w-0 flex-1 flex-col gap-px rounded-md px-1.5 py-0.5 text-start hover:bg-state-hover";
const DOT = "mt-1.5 size-[7px] shrink-0 rounded-full";
// Relative times and counts here rewrite themselves on every refresh, so the
// digits are tabular to stop the row twitching.
const META =
  "flex gap-1.5 overflow-hidden whitespace-nowrap text-[11px] tabular-nums text-muted-foreground";
const SECTION_TITLE = "mb-0.5 mt-2 font-semibold text-muted-foreground";

/** What the detail screen is showing: a commit, or one uncommitted file. */
type Selection =
  | { kind: "commit"; commitId: string; createdAt: string; message: string }
  | { kind: "uncommitted"; path: string };

/** Anything the detail screen can be opened from: a stack, base, or history row. */
type CommitRef = { commitId: string; createdAt: string; message: string };

const UNCOMMITTED_SOURCE: PatchSource = { kind: "uncommitted" };

const STATUS_TONE: Readonly<Record<BranchStatus, string>> = {
  unpushed: "text-muted-foreground",
  pushed: "text-success",
  diverged: "text-warning",
  integrated: "text-success",
  conflicted: "text-destructive-text",
  empty: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const KIND_TONE: Readonly<Record<string, string>> = {
  added: "text-diff-added",
  deleted: "text-diff-removed",
};

function readRepository(threadId: string): string | null {
  try {
    return window.localStorage.getItem(`${REPOSITORY_STORAGE_PREFIX}${threadId}`);
  } catch {
    return null;
  }
}

function writeRepository(threadId: string, key: string | null): void {
  try {
    const storageKey = `${REPOSITORY_STORAGE_PREFIX}${threadId}`;
    if (key) window.localStorage.setItem(storageKey, key);
    else window.localStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable in an embedded browser; the choice still
    // applies for this mount, it just does not survive a reload.
  }
}

/**
 * A shell command inside prose. Notices are plain text nodes, so a command
 * written with Markdown backticks would reach the reader as backticks.
 */
function Command({ children }: { children: string }) {
  return (
    <code className="rounded bg-secondary px-1 py-px font-mono text-foreground" translate="no">
      {children}
    </code>
  );
}

/** A pill in the panel's vocabulary: outline, small, and colour-coded. */
function Pill({ tone, title, children }: { tone: string; title?: string; children: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 rounded-full border-current/40 px-1.5 py-0 text-[11px] font-normal",
        tone,
      )}
      title={title}
    >
      {children}
    </Badge>
  );
}

/**
 * The panel's explanation for every non-`ready` workspace. GitButler has a
 * setup step that plain Git does not, so "nothing here" is usually a state
 * the user can act on rather than an error.
 */
function UnavailableWorkspace({
  workspace,
  onRetry,
}: {
  workspace: Workspace;
  onRetry: () => void;
}) {
  const detail = workspace.reason;
  if (workspace.state === "cliMissing") {
    return (
      <Notice
        title="The GitButler CLI is not installed here"
        detail={
          <>
            Install <Command>but</Command> on the machine hosting this environment, then refresh.
          </>
        }
        onRetry={onRetry}
      />
    );
  }
  if (workspace.state === "setupRequired") {
    return (
      <Notice
        title="This repository is not a GitButler project"
        detail={
          <>
            Run <Command>but setup</Command> in the repository to start tracking it as a GitButler
            workspace, then refresh.
          </>
        }
        onRetry={onRetry}
      />
    );
  }
  if (workspace.state === "noRepository") {
    return <Notice title="No repository in this environment" detail={detail} onRetry={onRetry} />;
  }
  if (workspace.state === "noEnvironment") {
    return (
      <Notice
        title="No project environment"
        detail={detail ?? "Attach this thread to an environment to see its GitButler workspace."}
      />
    );
  }
  return (
    <Notice title="GitButler could not read this workspace" detail={detail} onRetry={onRetry} />
  );
}

function FileRow({
  change,
  active,
  onOpen,
}: {
  change: FileChange;
  active: boolean;
  onOpen: () => void;
}) {
  const separator = change.path.lastIndexOf("/");
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-1.5 py-px text-start hover:bg-state-hover",
          active && "bg-state-active",
        )}
        onClick={onOpen}
        title={change.path}
      >
        <span
          className={cn(
            "w-2.5 shrink-0 font-mono text-[10px]",
            KIND_TONE[change.kind] ?? "text-muted-foreground",
          )}
        >
          {changeSymbol(change.kind)}
        </span>
        <span className="min-w-0 shrink truncate">{change.path.slice(separator + 1)}</span>
        {/*
         * No `direction: rtl` on the directory column. It truncates from the
         * left, but it also reorders leading punctuation, so `.bb` renders as
         * `bb.`.
         */}
        {separator > 0 ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {change.path.slice(0, separator)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ChangeList({
  changes,
  activePath,
  onOpen,
}: {
  changes: readonly FileChange[];
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <ul className="mt-0.5 list-none ps-4">
      {changes.map((change) => (
        <FileRow
          key={change.path}
          change={change}
          active={change.path === activePath}
          onOpen={() => onOpen(change.path)}
        />
      ))}
    </ul>
  );
}

function CommitRow({ commit, tone, onOpen }: { commit: Commit; tone: string; onOpen: () => void }) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className={cn(DOT, commit.conflicted ? "bg-destructive" : tone)} />
      <button type="button" className={ROW} onClick={onOpen}>
        <span className="truncate">{subject(commit.message)}</span>
        <span className={META}>
          <code className="font-mono">{shortId(commit.commitId)}</code>
          {commit.conflicted ? <span className="text-destructive-text">conflicts</span> : null}
          <span>{relativeTime(commit.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}

function StackBlock({
  stack,
  onOpenCommit,
  onOpenFile,
}: {
  stack: Stack;
  onOpenCommit: (commit: Commit) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <section
      // 16px between stacks against the 8px between branches inside one, so
      // the rail is not the only thing saying where a stack ends.
      className="my-4 border-s-2 border-primary/45 py-0.5 ps-2.5"
      aria-label={`Stack ${stack.key}`}
    >
      {stack.branches.map((branch) => (
        <div
          key={branch.name}
          className="[&+&]:mt-2 [&+&]:border-t [&+&]:border-dashed [&+&]:border-border [&+&]:pt-2"
        >
          <header className="flex min-w-0 items-center gap-1.5 pb-0.5 pt-px">
            <span className="truncate font-semibold" title={branch.name}>
              {branch.name}
            </span>
            {BRANCH_STATUS_LABEL[branch.status] ? (
              <Pill tone={STATUS_TONE[branch.status]} title={branch.rawStatus}>
                {BRANCH_STATUS_LABEL[branch.status]}
              </Pill>
            ) : null}
            {branch.reviewId ? <Pill tone="text-primary">{`#${branch.reviewId}`}</Pill> : null}
          </header>
          {/*
           * Upstream commits used to be told apart from local ones by the dot
           * colour alone, which says nothing to anyone who cannot separate the
           * two hues. The heading carries the meaning; the colour repeats it.
           */}
          {branch.upstreamCommits.length > 0 ? (
            <>
              <p className={SECTION_TITLE}>
                Upstream, not in this branch{" "}
                <span className="tabular-nums">{branch.upstreamCommits.length}</span>
              </p>
              <ul className="list-none">
                {branch.upstreamCommits.map((commit) => (
                  <CommitRow
                    key={`upstream-${commit.commitId}`}
                    commit={commit}
                    tone="bg-warning"
                    onOpen={() => onOpenCommit(commit)}
                  />
                ))}
              </ul>
            </>
          ) : null}
          {branch.commits.length === 0 && branch.upstreamCommits.length === 0 ? (
            <p className="my-0.5 italic text-muted-foreground">
              No commits yet. Commit on this branch and they appear here.
            </p>
          ) : null}
          {/* Only needed opposite an upstream heading; alone the list is obvious. */}
          {branch.upstreamCommits.length > 0 && branch.commits.length > 0 ? (
            <p className={SECTION_TITLE}>In this branch</p>
          ) : null}
          <ul className="list-none">
            {branch.commits.map((commit) => (
              <CommitRow
                key={commit.commitId}
                commit={commit}
                tone="bg-primary"
                onOpen={() => onOpenCommit(commit)}
              />
            ))}
          </ul>
        </div>
      ))}
      {stack.assignedChanges.length > 0 ? (
        <div className="mt-1.5">
          <p className={SECTION_TITLE}>
            Assigned changes{" "}
            <span className="tabular-nums text-muted-foreground">
              {stack.assignedChanges.length}
            </span>
          </p>
          <ChangeList changes={stack.assignedChanges} activePath={null} onOpen={onOpenFile} />
        </div>
      ) : null}
    </section>
  );
}

function BaseHistory({
  threadId,
  repositoryKey,
  from,
  onOpenCommit,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  from: string;
  onOpenCommit: (commit: CommitRef) => void;
}) {
  const [limit, setLimit] = useState(BASE_HISTORY_PAGE);
  // A new base means a different history; start the window over.
  useEffect(() => setLimit(BASE_HISTORY_PAGE), [from]);

  const history = rpc.baseHistory.useQuery(
    defined({ threadId, repositoryKey, from, offset: 0, limit }),
    { staleTime: REFRESH_INTERVAL_MS },
  );

  if (history.isPending) return <Loading label="Loading history…" />;
  if (history.isError)
    return (
      <Notice
        title="History failed to load"
        detail={errorText(history.error)}
        onRetry={() => void history.refetch()}
      />
    );
  if (history.data.reason)
    return (
      <Notice
        title="History unavailable"
        detail={history.data.reason}
        onRetry={() => void history.refetch()}
      />
    );

  return (
    <>
      <ul className="list-none">
        {history.data.commits.map((commit) => (
          <li key={commit.commitId} className="flex min-w-0 items-start gap-2">
            <span className={cn(DOT, "border border-muted-foreground bg-transparent")} />
            <button type="button" className={ROW} onClick={() => onOpenCommit(commit)}>
              <span className="truncate">{subject(commit.message)}</span>
              <span className={META}>
                <code className="font-mono">{shortId(commit.commitId)}</code>
                <span>{commit.authorName}</span>
                <span>{relativeTime(commit.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {history.data.hasMore && limit < BASE_HISTORY_MAX ? (
        <Button
          variant="outline"
          size="sm"
          className="ms-4 mt-2 h-6 px-2.5 text-xs font-normal text-muted-foreground"
          onClick={() =>
            setLimit((current) => Math.min(BASE_HISTORY_MAX, current + BASE_HISTORY_PAGE))
          }
        >
          {/* Names what is hidden without claiming a count the CLI has not sent. */}
          Load more commits
        </Button>
      ) : null}
    </>
  );
}

/**
 * Shown in place of the repository name, not beside it: the name the header
 * would print is the same string this control already displays.
 */
function RepositoryPicker({
  repositories,
  value,
  onChange,
}: {
  repositories: readonly Repository[];
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  return (
    <select
      className="min-w-0 flex-1 cursor-pointer truncate rounded-md border border-border bg-background px-1 py-0.5 text-xs text-foreground"
      value={value ?? repositories[0]?.key ?? ""}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Repository"
    >
      {repositories.map((repository) => (
        <option key={repository.key} value={repository.key}>
          {repository.name}
        </option>
      ))}
    </select>
  );
}

function CommitDetail({
  threadId,
  repositoryKey,
  selection,
  openPath,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Extract<Selection, { kind: "commit" }>;
  openPath: string | null;
}) {
  const details = rpc.commit.useQuery(
    defined({ threadId, repositoryKey, commitId: selection.commitId }),
    { staleTime: Number.POSITIVE_INFINITY },
  );
  const source = useMemo<PatchSource>(
    () => ({ kind: "commit", commitId: selection.commitId }),
    [selection.commitId],
  );
  const message = details.data?.message ?? selection.message;

  return (
    <>
      <h2 className="m-0 text-[13px] font-semibold text-balance [overflow-wrap:anywhere]">
        {subject(message)}
      </h2>
      <p className="mt-1 flex gap-2 text-[11px] tabular-nums text-muted-foreground">
        <code className="font-mono">{shortId(selection.commitId)}</code>
        {details.data ? <span>{details.data.authorName}</span> : null}
        <span>{relativeTime(selection.createdAt)}</span>
      </p>
      {details.isError ? (
        <Notice
          title="Commit failed to load"
          detail={errorText(details.error)}
          onRetry={() => void details.refetch()}
        />
      ) : null}
      <FileCards
        threadId={threadId}
        repositoryKey={repositoryKey}
        source={source}
        initialPath={openPath}
      />
    </>
  );
}

function DetailScreen({
  threadId,
  repositoryKey,
  selection,
  openPath,
  onBack,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Selection;
  openPath: string | null;
  onBack: () => void;
}) {
  return (
    <div className={SHELL}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
          onClick={onBack}
        >
          <Icon name="ArrowLeft" className="size-3" aria-hidden />
          Workspace
        </Button>
      </header>
      <div className={SCROLL}>
        {selection.kind === "commit" ? (
          <CommitDetail
            threadId={threadId}
            repositoryKey={repositoryKey}
            selection={selection}
            openPath={openPath}
          />
        ) : (
          <>
            <h2 className="m-0 text-[13px] font-semibold">Uncommitted</h2>
            <FileCards
              threadId={threadId}
              repositoryKey={repositoryKey}
              source={UNCOMMITTED_SOURCE}
              initialPath={selection.path}
            />
          </>
        )}
      </div>
    </div>
  );
}

function UncommittedSection({
  changes,
  onOpenFile,
}: {
  changes: readonly FileChange[];
  onOpenFile: (path: string) => void;
}) {
  // Closed by default: a busy worktree is dozens of rows, and the stacks are
  // what the panel is for.
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section className="mb-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-full justify-start gap-2 px-1.5 text-xs font-semibold"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={listId}
        disabled={changes.length === 0}
      >
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90",
            changes.length === 0 && "invisible",
          )}
          aria-hidden
        />
        <span className={cn(DOT, "mt-0 bg-warning")} />
        Uncommitted <span className="tabular-nums text-muted-foreground">{changes.length}</span>
      </Button>
      <div id={listId} hidden={!open || changes.length === 0}>
        {open && changes.length > 0 ? (
          <ChangeList changes={changes} activePath={null} onOpen={onOpenFile} />
        ) : null}
      </div>
    </section>
  );
}

function BaseSection({
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
  return (
    <>
      <div className="mb-1.5 mt-3.5 flex min-w-0 items-start gap-2 border-t border-border pt-2.5">
        <span className={cn(DOT, "border border-foreground bg-transparent")} />
        <button type="button" className={ROW} onClick={() => onOpenCommit(base)}>
          <span className="truncate">{subject(base.message)}</span>
          <span className={META}>
            <code className="font-mono">{shortId(base.commitId)}</code>
            <Pill tone="text-muted-foreground">common base</Pill>
            <span>{relativeTime(base.createdAt)}</span>
          </span>
        </button>
      </div>
      {/* The list below carried no label, so it read as commits from nowhere. */}
      <p className={SECTION_TITLE}>Before the common base</p>
      <BaseHistory
        threadId={threadId}
        repositoryKey={repositoryKey}
        from={base.commitId}
        onOpenCommit={onOpenCommit}
      />
    </>
  );
}

function WorkspaceBody({
  threadId,
  repositoryKey,
  data,
  onOpenCommit,
  onOpenFile,
  onRetry,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  data: Workspace;
  onOpenCommit: (commit: CommitRef) => void;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (data.state !== "ready") return <UnavailableWorkspace workspace={data} onRetry={onRetry} />;
  return (
    <>
      <UncommittedSection changes={data.unassignedChanges} onOpenFile={onOpenFile} />
      {data.stacks.map((stack) => (
        <StackBlock
          key={stack.key}
          stack={stack}
          onOpenCommit={onOpenCommit}
          onOpenFile={onOpenFile}
        />
      ))}
      {data.stacks.length === 0 ? (
        <div className="my-3 ms-2.5 text-muted-foreground">
          <p className="font-semibold text-foreground">No applied branches</p>
          <p className="mt-1 leading-normal">
            Branches you apply in GitButler show up here as stacks, with their commits.
          </p>
        </div>
      ) : null}
      {data.base ? (
        <BaseSection
          threadId={threadId}
          repositoryKey={repositoryKey}
          base={data.base}
          onOpenCommit={onOpenCommit}
        />
      ) : null}
    </>
  );
}

function WorkspacePanel({ threadId }: { threadId: string }) {
  const [repositoryKey, setRepositoryKey] = useState<string | undefined>(
    () => readRepository(threadId) ?? undefined,
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const repositories = rpc.repositories.useQuery({ threadId }, { staleTime: 60_000 });
  const workspace = rpc.workspace.useQuery(defined({ threadId, repositoryKey }), {
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
    // The panel already retries every ten seconds. The query client's default
    // ladder only added seven more of "Loading workspace…" before the reader
    // was told anything had gone wrong.
    retry: 1,
  });

  const chooseRepository = useCallback(
    (key: string) => {
      setRepositoryKey(key);
      writeRepository(threadId, key);
      setSelection(null);
      setOpenPath(null);
    },
    [threadId],
  );

  const openCommit = useCallback((commit: CommitRef) => {
    setSelection({
      kind: "commit",
      commitId: commit.commitId,
      createdAt: commit.createdAt,
      message: commit.message,
    });
    setOpenPath(null);
  }, []);

  const openUncommittedFile = useCallback((path: string) => {
    setSelection({ kind: "uncommitted", path });
    setOpenPath(path);
  }, []);

  const back = useCallback(() => {
    setSelection(null);
    setOpenPath(null);
  }, []);

  // Selection first: a failed background poll should not throw the reader out
  // of the commit they had open.
  if (selection) {
    return (
      <DetailScreen
        threadId={threadId}
        repositoryKey={repositoryKey}
        selection={selection}
        openPath={openPath}
        onBack={back}
      />
    );
  }

  const data = workspace.data;
  const behind = data?.upstream?.behind ?? 0;
  const choices = repositories.data?.repositories ?? [];
  const refresh = () => {
    setRefreshing(true);
    void workspace.refetch().finally(() => setRefreshing(false));
  };

  /*
   * The header is drawn in every state, loading and failure included. It used
   * to be skipped for both, which took Refresh away at exactly the moment a
   * reader needed it and left the failure with no way out of itself.
   */
  return (
    <div className={SHELL}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5">
        {choices.length > 1 ? (
          <RepositoryPicker
            repositories={choices}
            value={repositoryKey}
            onChange={chooseRepository}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-semibold"
            title={data?.repoName || undefined}
          >
            {data?.repoName || "GitButler"}
          </span>
        )}
        {behind > 0 ? <Pill tone="text-warning">{`${behind} behind`}</Pill> : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={refresh}
          aria-label="Refresh"
          aria-busy={refreshing}
        >
          {/*
           * The spinner tracks the click, not `isFetching`: the panel polls
           * every ten seconds, so tying it to the query made the icon blink
           * six times a minute on its own.
           */}
          <Icon name={refreshing ? "Spinner" : "RotateCcw"} className="size-3.5" aria-hidden />
        </Button>
      </header>
      <div className={SCROLL}>
        {workspace.isPending ? (
          <Loading label="Loading workspace…" />
        ) : workspace.isError ? (
          <Notice
            title="GitButler could not be reached"
            detail={errorText(workspace.error)}
            onRetry={refresh}
          />
        ) : (
          <WorkspaceBody
            threadId={threadId}
            repositoryKey={repositoryKey}
            data={workspace.data}
            onOpenCommit={openCommit}
            onOpenFile={openUncommittedFile}
            onRetry={refresh}
          />
        )}
      </div>
    </div>
  );
}

function GitButlerApp({ threadId }: { threadId?: string }) {
  const context = useBbContext();
  const resolved = threadId ?? context.threadId ?? null;
  if (!resolved) {
    return (
      <div className={cn(SHELL, "px-2.5")}>
        <Notice title="Open a thread to see its GitButler workspace" />
      </div>
    );
  }
  return (
    <PluginQueryBoundary>
      <WorkspacePanel key={resolved} threadId={resolved} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "gitbutler",
    title: "GitButler",
    icon: "GitBranch",
    component: GitButlerApp,
    layout: "flush",
  });
});
