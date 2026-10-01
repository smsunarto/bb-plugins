import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbContext,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import type { PatchSource, Repository, Workspace } from "../shared/schema.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import { FileCards } from "./file-cards.tsx";
import { GitButlerMark } from "./gitbutler-mark.tsx";
import { COMMIT_QUERY, queryClient } from "./query-client.ts";
import { rpc, defined } from "./rpc.ts";
import { relativeTime, shortId, subject } from "./format.ts";
import { BaseCard, StackLane, UncommittedCard } from "./workspace-lane.tsx";
import type { CommitRef } from "./workspace-lane.tsx";
import "./gitbutler.css";

const REFRESH_INTERVAL_MS = 10_000;
const REPOSITORY_STORAGE_PREFIX = "bb-plugin-gitbutler:repository:";
/** Shared with the server, which adds this tab to new GitButler threads. */
const PANEL_ACTION_ID = "gitbutler";
const HEADER_LABEL = "View in GitButler";

const SHELL = "flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground text-xs";
// The scrollbar's column is reserved up front, on both edges. Without it, the
// first row that pushed the panel past its height brought a scrollbar with it
// and shoved every line already on screen sideways. One edge alone would have
// fixed that but left the list sitting closer to its left border than its
// right.
const GUTTER = "[scrollbar-gutter:stable_both-edges]";
// Hidden overflow is what lets a header that never scrolls reserve the same
// gutters, so its text starts where the rows below it do.
const HEADER = `flex shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-card px-2.5 py-1.5 ${GUTTER}`;
/** What the detail screen is showing: a commit, or one uncommitted file. */
type Selection =
  | { kind: "commit"; commitId: string; createdAt: string; message: string }
  | { kind: "uncommitted"; path: string };

const UNCOMMITTED_SOURCE: PatchSource = { kind: "uncommitted" };

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
/**
 * The panel's scroll container. Each reserved gutter is as wide as the reader's
 * scrollbar, which is 11px when scrollbars are classic and 0 when they overlay
 * the page, and CSS has no way to read which. The top inset is measured to
 * match, so the first row sits as far below the header as it does from the
 * panel's sides.
 */
function ScrollArea({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      element.style.setProperty("--gutter", `${(element.offsetWidth - element.clientWidth) / 2}px`);
    };
    measure();
    // macOS swaps overlay scrollbars for classic ones when a mouse is plugged
    // in. The content box narrows when that happens, which this observes.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cn(
        "min-h-0 flex-1 overflow-auto px-2.5 pb-6 pt-[calc(--spacing(2.5)+var(--gutter,0px))]",
        GUTTER,
      )}
    >
      {children}
    </div>
  );
}

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
    COMMIT_QUERY,
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
      <header className={HEADER}>
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
      <ScrollArea>
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
      </ScrollArea>
    </div>
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
      <div className="flex flex-col gap-4">
        <UncommittedCard changes={data.unassignedChanges} onOpenFile={onOpenFile} />
        {data.stacks.map((stack) => (
          <StackLane
            key={stack.key}
            target={{ threadId, repositoryKey }}
            stack={stack}
            onOpenCommit={onOpenCommit}
            onOpenFile={onOpenFile}
          />
        ))}
        {data.stacks.length === 0 ? (
          <div className="ms-2.5 text-muted-foreground">
            <p className="font-semibold text-foreground">No applied branches</p>
            <p className="mt-1 leading-normal">
              Branches you apply in GitButler show up here as stacks, with their commits.
            </p>
          </div>
        ) : null}
        {data.base ? (
          <BaseCard
            threadId={threadId}
            repositoryKey={repositoryKey}
            base={data.base}
            onOpenCommit={onOpenCommit}
          />
        ) : null}
      </div>
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
      <header className={HEADER}>
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
      <ScrollArea>
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
      </ScrollArea>
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
    <PluginQueryBoundary client={queryClient}>
      <WorkspacePanel key={resolved} threadId={resolved} />
    </PluginQueryBoundary>
  );
}

/**
 * A button in the thread header that opens the GitButler tab, or focuses it
 * when it is already open. Draws nothing outside a GitButler workspace, so
 * threads in other repositories keep a clean header. It reads the same query
 * as the panel, so an open panel answers it from cache.
 */
function HeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const repositoryKey = readRepository(threadId) ?? undefined;
  const workspace = rpc.workspace.useQuery(defined({ threadId, repositoryKey }), {
    staleTime: 60_000,
  });
  if (workspace.data?.state !== "ready") return null;
  return (
    // bb's own toolbar buttons (the editor picker beside this one) are an
    // outline button with this sizing, so the two read as one row of controls.
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 border-border px-2 text-xs font-medium text-foreground shadow-none max-md:pointer-coarse:h-9"
      aria-label={HEADER_LABEL}
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
    >
      <GitButlerMark className="size-4 shrink-0" />
      {isCompactViewport ? null : HEADER_LABEL}
    </Button>
  );
}

function HeaderAction(props: PluginThreadHeaderActionProps) {
  return (
    <PluginQueryBoundary client={queryClient}>
      <HeaderButton key={props.threadId} {...props} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "open",
    title: "GitButler",
    component: HeaderAction,
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "GitButler",
    icon: "GitBranch",
    component: GitButlerApp,
    layout: "flush",
  });
});
