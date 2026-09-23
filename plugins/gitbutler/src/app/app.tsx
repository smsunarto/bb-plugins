import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  BRANCH_STATUS_LABEL,
  body,
  changeSymbol,
  relativeTime,
  shortId,
  subject,
} from "./format.ts";
import "./gitbutler.css";

const REFRESH_INTERVAL_MS = 10_000;
const BASE_HISTORY_PAGE = 60;
const BASE_HISTORY_MAX = 500;
const REPOSITORY_STORAGE_PREFIX = "bb-plugin-gitbutler:repository:";

const SHELL = "flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground text-xs";
const SCROLL = "min-h-0 flex-1 overflow-auto px-2.5 pb-6 pt-2";
const ROW =
  "flex min-w-0 flex-1 flex-col gap-px rounded-md px-1.5 py-0.5 text-left hover:bg-state-hover";
const DOT = "mt-1.5 size-[7px] shrink-0 rounded-full";
const META = "flex gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground";
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

/** A pill in the panel's vocabulary: outline, small, and colour-coded. */
function Pill({ tone, title, children }: { tone: string; title?: string; children: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 rounded-full border-current/40 px-1.5 py-0 text-[10px] font-normal",
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
function UnavailableWorkspace({ workspace }: { workspace: Workspace }) {
  const detail = workspace.reason;
  if (workspace.state === "cliMissing") {
    return (
      <Notice
        title="The GitButler CLI is not installed here"
        detail="Install `but` on the machine hosting this environment, then reopen this panel."
      />
    );
  }
  if (workspace.state === "setupRequired") {
    return (
      <Notice
        title="This repository is not a GitButler project"
        detail="Run `but setup` in the repository to start tracking it as a GitButler workspace."
      />
    );
  }
  if (workspace.state === "noRepository") {
    return <Notice title="No repository in this environment" detail={detail} />;
  }
  if (workspace.state === "noEnvironment") {
    return <Notice title="No project environment" detail={detail} />;
  }
  return <Notice title="GitButler could not read this workspace" detail={detail} />;
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
          "flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-1.5 py-px text-left hover:bg-state-hover",
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
    <ul className="mt-0.5 list-none pl-4">
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
      className="my-2.5 border-l-2 border-primary/45 py-0.5 pl-2.5"
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
          {branch.upstreamCommits.length > 0 ? (
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
          ) : null}
          {branch.commits.length === 0 && branch.upstreamCommits.length === 0 ? (
            <p className="my-0.5 italic text-muted-foreground">No commits yet</p>
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
    return <Notice title="History failed to load" detail={errorText(history.error)} />;
  if (history.data.reason)
    return <Notice title="History unavailable" detail={history.data.reason} />;

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
          className="ml-4 mt-2 h-6 px-2.5 text-xs font-normal text-muted-foreground"
          onClick={() =>
            setLimit((current) => Math.min(BASE_HISTORY_MAX, current + BASE_HISTORY_PAGE))
          }
        >
          Load more
        </Button>
      ) : null}
    </>
  );
}

function RepositoryPicker({
  repositories,
  value,
  onChange,
}: {
  repositories: readonly Repository[];
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  if (repositories.length < 2) return null;
  return (
    <select
      className="max-w-[45%] cursor-pointer rounded-md border border-border bg-background px-1 py-0.5 text-xs text-foreground"
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
      <h2 className="m-0 text-[13px] font-semibold [overflow-wrap:anywhere]">{subject(message)}</h2>
      {body(message) ? (
        <pre className="my-1.5 whitespace-pre-wrap rounded-md bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {body(message)}
        </pre>
      ) : null}
      <p className="mt-1 flex gap-2 text-[11px] text-muted-foreground">
        <code className="font-mono">{shortId(selection.commitId)}</code>
        {details.data ? <span>{details.data.authorName}</span> : null}
        <span>{relativeTime(selection.createdAt)}</span>
      </p>
      {details.isError ? (
        <Notice title="Commit failed to load" detail={errorText(details.error)} />
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
  return (
    <section className="mb-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-full justify-start gap-2 px-1.5 text-xs font-semibold"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        disabled={changes.length === 0}
      >
        <Icon
          name="ChevronRight"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            changes.length === 0 && "invisible",
          )}
          aria-hidden
        />
        <span className={cn(DOT, "mt-0 bg-warning")} />
        Uncommitted <span className="tabular-nums text-muted-foreground">{changes.length}</span>
      </Button>
      {open && changes.length > 0 ? (
        <ChangeList changes={changes} activePath={null} onOpen={onOpenFile} />
      ) : null}
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
}: {
  threadId: string;
  repositoryKey: string | undefined;
  data: Workspace;
  onOpenCommit: (commit: CommitRef) => void;
  onOpenFile: (path: string) => void;
}) {
  if (data.state !== "ready") return <UnavailableWorkspace workspace={data} />;
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
        <p className="my-3 ml-2.5 italic text-muted-foreground">No applied branches</p>
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

  const repositories = rpc.repositories.useQuery({ threadId }, { staleTime: 60_000 });
  const workspace = rpc.workspace.useQuery(defined({ threadId, repositoryKey }), {
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
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

  if (workspace.isPending) {
    return (
      <div className={cn(SHELL, "px-2.5")}>
        <Loading label="Loading workspace…" />
      </div>
    );
  }
  if (workspace.isError) {
    return (
      <div className={cn(SHELL, "px-2.5")}>
        <Notice title="GitButler could not be reached" detail={errorText(workspace.error)} />
      </div>
    );
  }
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
  const behind = data.upstream?.behind ?? 0;

  return (
    <div className={SHELL}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5">
        <span className="truncate font-semibold">{data.repoName || "GitButler"}</span>
        <RepositoryPicker
          repositories={repositories.data?.repositories ?? []}
          value={repositoryKey}
          onChange={chooseRepository}
        />
        <span className="flex-1" />
        {behind > 0 ? <Pill tone="text-warning">{`${behind} behind`}</Pill> : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={() => void workspace.refetch()}
          disabled={workspace.isFetching}
          aria-label="Refresh"
        >
          <Icon name={workspace.isFetching ? "Spinner" : "RotateCcw"} className="size-3.5" />
        </Button>
      </header>
      <div className={SCROLL}>
        <WorkspaceBody
          threadId={threadId}
          repositoryKey={repositoryKey}
          data={data}
          onOpenCommit={openCommit}
          onOpenFile={openUncommittedFile}
        />
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
