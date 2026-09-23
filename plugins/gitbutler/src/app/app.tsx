import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_Diff as Diff, useBbContext } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import type {
  BaseCommit,
  Commit,
  FileChange,
  PatchSource,
  Repository,
  Stack,
  Workspace,
} from "../shared/schema.ts";
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

/** What the detail screen is showing: a commit, or one uncommitted file. */
type Selection =
  | { kind: "commit"; commitId: string; createdAt: string; message: string }
  | { kind: "uncommitted"; path: string };

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function Notice({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="gb-notice">
      <p className="gb-notice-title">{title}</p>
      {detail ? <p className="gb-notice-detail">{detail}</p> : null}
    </div>
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
        className={`gb-file${active ? " gb-active" : ""}`}
        onClick={onOpen}
        title={change.path}
      >
        <span className={`gb-file-kind gb-kind-${change.kind}`}>{changeSymbol(change.kind)}</span>
        <span className="gb-file-name">{change.path.slice(separator + 1)}</span>
        {separator > 0 ? (
          <span className="gb-file-dir">{change.path.slice(0, separator)}</span>
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
    <ul className="gb-files">
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

function CommitRow({
  commit,
  tone,
  onOpen,
}: {
  commit: Commit;
  tone: "stack" | "upstream" | "base";
  onOpen: () => void;
}) {
  return (
    <li className="gb-row">
      <span className={`gb-dot gb-dot-${tone}${commit.conflicted ? " gb-dot-conflicted" : ""}`} />
      <button type="button" className="gb-commit" onClick={onOpen}>
        <span className="gb-commit-subject">{subject(commit.message)}</span>
        <span className="gb-commit-meta">
          <code>{shortId(commit.commitId)}</code>
          {commit.conflicted ? <span className="gb-conflicted">conflicts</span> : null}
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
  activePath,
}: {
  stack: Stack;
  onOpenCommit: (commit: Commit) => void;
  onOpenFile: (path: string) => void;
  activePath: string | null;
}) {
  return (
    <section className="gb-stack" aria-label={`Stack ${stack.key}`}>
      {stack.branches.map((branch) => (
        <div key={branch.name} className="gb-branch">
          <header className="gb-branch-head">
            <span className="gb-branch-name" title={branch.name}>
              {branch.name}
            </span>
            {BRANCH_STATUS_LABEL[branch.status] ? (
              <span className={`gb-pill gb-pill-${branch.status}`} title={branch.rawStatus}>
                {BRANCH_STATUS_LABEL[branch.status]}
              </span>
            ) : null}
            {branch.reviewId ? (
              <span className="gb-pill gb-pill-review">#{branch.reviewId}</span>
            ) : null}
          </header>
          {branch.upstreamCommits.length > 0 ? (
            <ul className="gb-commits">
              {branch.upstreamCommits.map((commit) => (
                <CommitRow
                  key={`upstream-${commit.commitId}`}
                  commit={commit}
                  tone="upstream"
                  onOpen={() => onOpenCommit(commit)}
                />
              ))}
            </ul>
          ) : null}
          {branch.commits.length === 0 && branch.upstreamCommits.length === 0 ? (
            <p className="gb-empty-branch">No commits yet</p>
          ) : null}
          <ul className="gb-commits">
            {branch.commits.map((commit) => (
              <CommitRow
                key={commit.commitId}
                commit={commit}
                tone="stack"
                onOpen={() => onOpenCommit(commit)}
              />
            ))}
          </ul>
        </div>
      ))}
      {stack.assignedChanges.length > 0 ? (
        <div className="gb-assigned">
          <p className="gb-assigned-title">
            Assigned changes <span className="gb-count">{stack.assignedChanges.length}</span>
          </p>
          <ChangeList changes={stack.assignedChanges} activePath={activePath} onOpen={onOpenFile} />
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
  onOpenCommit: (commit: { commitId: string; createdAt: string; message: string }) => void;
}) {
  const [limit, setLimit] = useState(BASE_HISTORY_PAGE);
  // A new base means a different history; start the window over.
  useEffect(() => setLimit(BASE_HISTORY_PAGE), [from]);

  const history = rpc.baseHistory.useQuery(
    defined({ threadId, repositoryKey, from, offset: 0, limit }),
    {
      staleTime: REFRESH_INTERVAL_MS,
    },
  );

  if (history.isPending) return <p className="gb-loading">Loading history…</p>;
  if (history.isError)
    return <Notice title="History failed to load" detail={errorText(history.error)} />;
  if (history.data.reason)
    return <Notice title="History unavailable" detail={history.data.reason} />;

  const commits = history.data.commits;
  return (
    <>
      <ul className="gb-commits gb-history">
        {commits.map((commit) => (
          <li key={commit.commitId} className="gb-row">
            <span className="gb-dot gb-dot-base" />
            <button type="button" className="gb-commit" onClick={() => onOpenCommit(commit)}>
              <span className="gb-commit-subject">{subject(commit.message)}</span>
              <span className="gb-commit-meta">
                <code>{shortId(commit.commitId)}</code>
                <span>{commit.authorName}</span>
                <span>{relativeTime(commit.createdAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {history.data.hasMore && limit < BASE_HISTORY_MAX ? (
        <button
          type="button"
          className="gb-more"
          onClick={() =>
            setLimit((current) => Math.min(BASE_HISTORY_MAX, current + BASE_HISTORY_PAGE))
          }
        >
          Load more
        </button>
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
      className="gb-repo"
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

function PatchView({
  threadId,
  repositoryKey,
  source,
  path,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  source: PatchSource;
  path: string;
}) {
  const patch = rpc.patch.useQuery(defined({ threadId, repositoryKey, source, path }), {
    staleTime: REFRESH_INTERVAL_MS,
  });

  if (patch.isPending) return <p className="gb-loading">Loading diff…</p>;
  if (patch.isError) return <Notice title="Diff failed to load" detail={errorText(patch.error)} />;
  if (patch.data.patch === "") {
    return <Notice title="No text diff" detail="This file is binary, empty, or unchanged." />;
  }
  return (
    <div className="gb-diff">
      {patch.data.truncated ? <p className="gb-truncated">Diff truncated.</p> : null}
      <Diff patch={patch.data.patch} path={path} view="unified" />
    </div>
  );
}

function CommitDetail({
  threadId,
  repositoryKey,
  selection,
  openPath,
  onOpenPath,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Extract<Selection, { kind: "commit" }>;
  openPath: string | null;
  onOpenPath: (path: string | null) => void;
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
      <div className="gb-detail-head">
        <h2>{subject(message)}</h2>
        {body(message) ? <pre className="gb-detail-body">{body(message)}</pre> : null}
        <p className="gb-detail-meta">
          <code>{shortId(selection.commitId)}</code>
          {details.data ? <span>{details.data.authorName}</span> : null}
          <span>{relativeTime(selection.createdAt)}</span>
        </p>
      </div>
      {details.isPending ? <p className="gb-loading">Loading files…</p> : null}
      {details.isError ? (
        <Notice title="Commit failed to load" detail={errorText(details.error)} />
      ) : null}
      {details.data ? (
        <>
          <p className="gb-section-title">
            Files <span className="gb-count">{details.data.files.length}</span>
          </p>
          <ChangeList changes={details.data.files} activePath={openPath} onOpen={onOpenPath} />
        </>
      ) : null}
      {openPath ? (
        <PatchView
          threadId={threadId}
          repositoryKey={repositoryKey}
          source={source}
          path={openPath}
        />
      ) : null}
    </>
  );
}

const UNCOMMITTED_SOURCE: PatchSource = { kind: "uncommitted" };

/** Anything the detail screen can be opened from: a stack, base, or history row. */
type CommitRef = { commitId: string; createdAt: string; message: string };

function DetailScreen({
  threadId,
  repositoryKey,
  selection,
  openPath,
  onOpenPath,
  onBack,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Selection;
  openPath: string | null;
  onOpenPath: (path: string | null) => void;
  onBack: () => void;
}) {
  return (
    <div className="gb-app">
      <header className="gb-header">
        <button type="button" className="gb-back" onClick={onBack}>
          ← Workspace
        </button>
      </header>
      <div className="gb-scroll">
        {selection.kind === "commit" ? (
          <CommitDetail
            threadId={threadId}
            repositoryKey={repositoryKey}
            selection={selection}
            openPath={openPath}
            onOpenPath={onOpenPath}
          />
        ) : (
          <>
            <div className="gb-detail-head">
              <h2>{selection.path}</h2>
              <p className="gb-detail-meta">
                <span>Uncommitted</span>
              </p>
            </div>
            <PatchView
              threadId={threadId}
              repositoryKey={repositoryKey}
              source={UNCOMMITTED_SOURCE}
              path={selection.path}
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
    <section className="gb-uncommitted">
      <button
        type="button"
        className="gb-disclosure"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        disabled={changes.length === 0}
      >
        <span className="gb-chevron" aria-hidden="true">
          ▶
        </span>
        <span className="gb-dot gb-dot-uncommitted" />
        Uncommitted <span className="gb-count">{changes.length}</span>
      </button>
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
      <div className="gb-base">
        <span className="gb-dot gb-dot-base-tip" />
        <button type="button" className="gb-commit" onClick={() => onOpenCommit(base)}>
          <span className="gb-commit-subject">{subject(base.message)}</span>
          <span className="gb-commit-meta">
            <code>{shortId(base.commitId)}</code>
            <span className="gb-pill gb-pill-base">common base</span>
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
          activePath={null}
        />
      ))}
      {data.stacks.length === 0 ? (
        <p className="gb-empty-branch gb-no-stacks">No applied branches</p>
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
      <div className="gb-app">
        <p className="gb-loading">Loading workspace…</p>
      </div>
    );
  }
  if (workspace.isError) {
    return (
      <div className="gb-app">
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
        onOpenPath={setOpenPath}
        onBack={back}
      />
    );
  }

  const data = workspace.data;
  const behind = data.upstream?.behind ?? 0;

  return (
    <div className="gb-app">
      <header className="gb-header">
        <span className="gb-title">{data.repoName || "GitButler"}</span>
        <RepositoryPicker
          repositories={repositories.data?.repositories ?? []}
          value={repositoryKey}
          onChange={chooseRepository}
        />
        <span className="gb-spacer" />
        {behind > 0 ? <span className="gb-pill gb-pill-behind">{behind} behind</span> : null}
        <button
          type="button"
          className="gb-refresh"
          onClick={() => void workspace.refetch()}
          disabled={workspace.isFetching}
          aria-label="Refresh"
          title="Refresh"
        >
          ↻
        </button>
      </header>
      <div className="gb-scroll">
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
      <div className="gb-app">
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
