import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbContext,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { PANEL_ACTION_ID, TURN_ENDED_CHANNEL } from "../shared/panel.ts";
import type { ActionRisk, PatchSource, Repository, Workspace } from "../shared/schema.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import {
  Confirm,
  pullRiskPrompt,
  refreshWorkspace,
  useButAction,
  useFocusAfter,
} from "./branch-actions.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { Conflicts } from "./conflicts.tsx";
import { FileCards } from "./file-cards.tsx";
import { GitButlerMark } from "./gitbutler-mark.tsx";
import { REFRESH_INTERVAL_MS } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { storedAnswer } from "./stored-queries.ts";
import { relativeTime, shortId, subject } from "./format.ts";
import { BaseCard, CommitExpansionContext, StackLane, UncommittedCard } from "./workspace-lane.tsx";
import type { CommitExpansion, CommitRef } from "./workspace-lane.tsx";
import "./gitbutler.css";

const REPOSITORY_STORAGE_PREFIX = "bb-plugin-gitbutler:repository:";
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
/** What the detail screen is showing, and the file it opened on. */
type Selection =
  | { kind: "commit"; commit: CommitRef; path: string }
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
      data-scroll-area
      className={cn(
        "min-h-0 flex-1 overflow-auto px-2.5 pb-6 pt-[calc(--spacing(2.5)+var(--gutter,0px))]",
        GUTTER,
      )}
    >
      {children}
    </div>
  );
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
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Extract<Selection, { kind: "commit" }>;
}) {
  const { commit } = selection;
  const source = useMemo<PatchSource>(
    () => ({ kind: "commit", commitId: commit.commitId }),
    [commit.commitId],
  );
  const title = subject(commit.message);
  // Everything under the subject: where an agent's commit says why.
  const body = commit.message.slice(title.length).trim();

  return (
    <>
      <h2 className="m-0 text-sm font-semibold text-balance [overflow-wrap:anywhere]">{title}</h2>
      <p className="mt-1 flex gap-2 text-[11px] tabular-nums text-muted-foreground">
        <code className="font-mono">{shortId(commit.commitId)}</code>
        <span>{commit.authorName}</span>
        <span>{relativeTime(commit.createdAt)}</span>
      </p>
      {body ? (
        <p className="mt-2 whitespace-pre-wrap leading-normal text-muted-foreground [overflow-wrap:anywhere]">
          {body}
        </p>
      ) : null}
      <FileCards
        threadId={threadId}
        repositoryKey={repositoryKey}
        source={source}
        initialPath={selection.path}
      />
    </>
  );
}

function DetailScreen({
  threadId,
  repositoryKey,
  selection,
  onBack,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  selection: Selection;
  onBack: () => void;
}) {
  return (
    // Escape goes back from wherever the focus is on this screen. Focusable
    // itself, so a click into the diff text keeps the focus here.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(SHELL, "outline-none")}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) onBack();
      }}
    >
      <header className={HEADER}>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
          aria-label="Back to workspace"
          // The workspace under this screen goes inert and drops the focus,
          // so the focus starts here instead of on the page body.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onClick={onBack}
        >
          <Icon name="ArrowLeft" className="size-3" aria-hidden />
          Workspace
        </Button>
      </header>
      <ScrollArea>
        {selection.kind === "commit" ? (
          <CommitDetail threadId={threadId} repositoryKey={repositoryKey} selection={selection} />
        ) : (
          <>
            <h2 className="m-0 text-sm font-semibold">Uncommitted</h2>
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
  onOpenFile,
  onRetry,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  data: Workspace;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (data.state !== "ready") return <UnavailableWorkspace workspace={data} onRetry={onRetry} />;
  return (
    <>
      <div className="flex flex-col gap-4">
        <Conflicts target={{ threadId, repositoryKey }} workspace={data} />
        <UncommittedCard changes={data.unassignedChanges} onOpenFile={onOpenFile} />
        {data.stacks.map((stack) => (
          <StackLane
            key={stack.key}
            target={{ threadId, repositoryKey }}
            stack={stack}
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
          <BaseCard threadId={threadId} repositoryKey={repositoryKey} base={data.base} />
        ) : null}
      </div>
    </>
  );
}

/**
 * The header's Pull: `but pull` for the whole workspace, which rebases every
 * applied branch onto the target branch. It fetches first, so it also finds
 * commits the "behind" count has not heard of. It asks before leaving
 * conflicts, and says so when there was nothing to pull.
 */
function useWorkspacePull(target: WorkspaceTarget) {
  const action = useButAction(target);
  // Tagged with the repository it is about, so switching drops it.
  const [outcome, setOutcome] = useState<{
    key: string | undefined;
    question: ActionRisk | null;
    upToDate: boolean;
  } | null>(null);
  const shown = outcome?.key === target.repositoryKey ? outcome : null;
  const start = (accepted: ActionRisk | null) => {
    setOutcome(null);
    action.run({ kind: "updateWorkspace", accepted }, (result) =>
      setOutcome({
        key: target.repositoryKey,
        question: result.status === "confirm" ? result.risk : null,
        upToDate: result.status === "upToDate",
      }),
    );
  };
  return {
    start,
    cancel: () => setOutcome(null),
    pending: action.pending,
    error: action.error,
    question: shown?.question ?? null,
    upToDate: shown?.upToDate ?? false,
  };
}

/** The header's Pull. Its spinner tracks its own request, as Refresh's does. */
const PullButton = forwardRef<
  HTMLButtonElement,
  { pull: ReturnType<typeof useWorkspacePull>; shown: boolean }
>(function PullButton({ pull, shown }, ref) {
  // Only a workspace that read cleanly has branches to pull into.
  if (!shown) return null;
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-xs font-normal"
      aria-label="Pull the target branch into the workspace"
      disabled={pull.pending}
      onClick={() => pull.start(null)}
    >
      <Icon
        name={pull.pending ? "Spinner" : "ArrowDown"}
        className={cn("size-3", pull.pending && "animate-spin")}
        aria-hidden
      />
      Pull
    </Button>
  );
});

/** The header's Pull button, which takes the focus back after a pull unless a question took it. */
function usePullFocus(pull: ReturnType<typeof useWorkspacePull>) {
  const button = useRef<HTMLButtonElement>(null);
  useFocusAfter(pull.pending, () => (pull.question ? null : button.current));
  return button;
}

/** Under the header: the Pull confirmation, its refusal, or its "nothing new". */
function WorkspacePullStatus({
  pull,
  pullButton,
}: {
  pull: ReturnType<typeof useWorkspacePull>;
  /** Where the focus goes back to when the reader backs out. */
  pullButton: RefObject<HTMLButtonElement | null>;
}) {
  const onCancel = () => {
    pull.cancel();
    pullButton.current?.focus();
  };
  const row = cn("shrink-0 border-b border-border px-2.5 py-1.5", GUTTER);
  if (pull.question) {
    return (
      <div className={row}>
        <Confirm
          prompt={pullRiskPrompt(pull.question)}
          label="Pull anyway"
          pending={pull.pending}
          onCancel={onCancel}
          onConfirm={() => pull.start(pull.question)}
        />
      </div>
    );
  }
  if (pull.error) {
    return (
      <p role="alert" className={cn(row, "text-[11px] leading-normal text-destructive-text")}>
        {pull.error.message}
      </p>
    );
  }
  if (pull.upToDate) {
    return (
      <output className={cn(row, "block text-[11px] text-muted-foreground")}>
        Already up to date.
      </output>
    );
  }
  return null;
}

/** Under the header while the board on screen is the last one that read cleanly. */
function StaleNote({ reason }: { reason: string | null }) {
  if (reason === null) return null;
  return (
    <p
      className={cn(
        "shrink-0 overflow-hidden border-b border-border px-2.5 py-1 text-[11px] text-muted-foreground",
        GUTTER,
      )}
      title={reason || undefined}
    >
      Couldn't refresh. Showing the last workspace.
    </p>
  );
}

/**
 * Redraws the panel once a minute. Relative times are plain text, and a poll
 * with nothing new redraws nothing, so without it "just now" would stay up
 * for an hour.
 */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
}

/**
 * The workspace to draw. A poll that fails after a good one keeps the board
 * the reader was using, with its open drafts and confirmations, and marks it
 * stale. Only a failure does: the other states are answers the reader has to
 * act on. The board kept is the current repository's, never another's.
 */
function useShownWorkspace(
  workspace: UseQueryResult<Workspace, Error>,
  repositoryKey: string | undefined,
): { data: Workspace | undefined; stale: string | null } {
  const [lastReady, setLastReady] = useState<{
    repositoryKey: string | undefined;
    data: Workspace;
  } | null>(null);
  const latest = workspace.data;
  if (latest?.state === "ready" && latest !== lastReady?.data) {
    setLastReady({ repositoryKey, data: latest });
  }
  const fallback =
    lastReady && lastReady.repositoryKey === repositoryKey ? lastReady.data : undefined;
  if (latest?.state === "error" && fallback) return { data: fallback, stale: latest.reason ?? "" };
  if (workspace.isRefetchError && latest?.state === "ready") {
    return { data: latest, stale: errorText(workspace.error) };
  }
  return { data: latest, stale: null };
}

function WorkspacePanel({ threadId }: { threadId: string }) {
  const [repositoryKey, setRepositoryKey] = useState<string | undefined>(
    () => readRepository(threadId) ?? undefined,
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // What had the focus when the detail screen opened, so Back returns it there.
  const returnFocus = useRef<HTMLElement | null>(null);
  const board = useRef<HTMLDivElement>(null);
  useMinuteTick();

  const repositories = rpc.repositories.useQuery(
    { threadId },
    { ...storedAnswer("repositories", { threadId }), staleTime: 60_000 },
  );
  const workspace = rpc.workspace.useQuery(
    { threadId, repositoryKey },
    {
      ...storedAnswer("workspace", { threadId, repositoryKey }),
      refetchInterval: REFRESH_INTERVAL_MS,
      refetchOnWindowFocus: true,
    },
  );

  const chooseRepository = useCallback(
    (key: string | undefined) => {
      setRepositoryKey(key);
      writeRepository(threadId, key ?? null);
      setSelection(null);
      setExpandedCommit(null);
    },
    [threadId],
  );

  /*
   * A remembered repository that has gone leaves the panel on a notice, often
   * with no picker to leave it by, so fall back to the default one. Not after
   * a failed discovery: it lists nothing, and a good choice would be lost.
   */
  useEffect(() => {
    const list = repositories.data;
    if (!list || list.reason !== null || list.repositories.length === 0) return;
    if (repositoryKey === undefined) return;
    if (list.repositories.some((repository) => repository.key === repositoryKey)) return;
    chooseRepository(undefined);
  }, [chooseRepository, repositories.data, repositoryKey]);

  const open = useCallback((next: Selection) => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(next);
  }, []);

  const expansion = useMemo<CommitExpansion>(
    () => ({
      threadId,
      repositoryKey,
      expanded: expandedCommit,
      onToggle: (key) => setExpandedCommit((current) => (current === key ? null : key)),
      onOpenFile: (commit, path) => open({ kind: "commit", commit, path }),
    }),
    [expandedCommit, open, repositoryKey, threadId],
  );

  const openUncommittedFile = useCallback(
    (path: string) => open({ kind: "uncommitted", path }),
    [open],
  );

  const back = useCallback(() => setSelection(null), []);

  // The workspace stayed mounted under the detail screen, so the row that
  // opened it is usually still there to take the focus back. It is gone once
  // its file was committed or GitButler rewrote its commit, and then the
  // board takes the focus instead of the page.
  useEffect(() => {
    const opener = returnFocus.current;
    if (selection !== null || opener === null) return;
    returnFocus.current = null;
    (opener.isConnected ? opener : board.current)?.focus();
  }, [selection]);

  useRealtime(TURN_ENDED_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) {
      void refreshWorkspace(threadId);
    }
  });

  const { data, stale } = useShownWorkspace(workspace, repositoryKey);
  const pull = useWorkspacePull({ threadId, repositoryKey });
  const pullButton = usePullFocus(pull);
  const behind = data?.upstream?.behind ?? 0;
  const choices = repositories.data?.repositories ?? [];
  const refresh = () => {
    setRefreshing(true);
    void workspace.refetch().finally(() => setRefreshing(false));
  };
  // A board drawn from storage or memory is checked as soon as the panel
  // opens. Until that first read lands, Refresh spins as if clicked, so a
  // board that is about to change says so.
  const syncing =
    refreshing || (data !== undefined && workspace.isFetching && !workspace.isFetchedAfterMount);

  /*
   * The header is drawn in every state, loading and failure included. It used
   * to be skipped for both, which took Refresh away at exactly the moment a
   * reader needed it and left the failure with no way out of itself.
   */
  return (
    <div className="relative h-full">
      <div
        ref={board}
        className={cn(SHELL, "outline-none")}
        tabIndex={-1}
        inert={selection !== null}
      >
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
          {behind > 0 ? <Pill tone="text-warning-text">{`${behind} behind`}</Pill> : null}
          <PullButton ref={pullButton} pull={pull} shown={data?.state === "ready"} />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            onClick={refresh}
            aria-label="Refresh"
            aria-busy={syncing}
          >
            {/*
             * The spinner tracks the click and the first check, not
             * `isFetching`: the panel polls every ten seconds, so tying it to
             * the query made the icon blink six times a minute on its own.
             */}
            <Icon
              name={syncing ? "Spinner" : "RotateCcw"}
              className={cn("size-3.5", syncing && "animate-spin")}
              aria-hidden
            />
          </Button>
        </header>
        <WorkspacePullStatus pull={pull} pullButton={pullButton} />
        <StaleNote reason={stale} />
        <ScrollArea>
          {data ? (
            <CommitExpansionContext.Provider value={expansion}>
              {/*
               * Keyed by repository: two repositories can share branch names,
               * and a card's open confirmation or draft must not carry over to
               * the same-named branch of the next one.
               */}
              <WorkspaceBody
                key={repositoryKey ?? ""}
                threadId={threadId}
                repositoryKey={repositoryKey}
                data={data}
                onOpenFile={openUncommittedFile}
                onRetry={refresh}
              />
            </CommitExpansionContext.Provider>
          ) : workspace.isError ? (
            <Notice
              title="GitButler could not be reached"
              detail={errorText(workspace.error)}
              onRetry={refresh}
            />
          ) : (
            <Loading label="Loading workspace…" />
          )}
        </ScrollArea>
      </div>
      {/*
       * Over the workspace, not in its place: Back finds the board scrolled
       * where the reader left it, and a failed poll behind the detail cannot
       * throw them out of the commit they had open.
       */}
      {selection ? (
        <div className="absolute inset-0">
          <DetailScreen
            threadId={threadId}
            repositoryKey={repositoryKey}
            selection={selection}
            onBack={back}
          />
        </div>
      ) : null}
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

/**
 * A button in the thread header that opens the GitButler tab, or focuses it
 * when it is already open. Draws nothing outside a GitButler workspace, so
 * threads in other repositories keep a clean header. It reads the same query
 * as the panel, so an open panel answers it from cache.
 */
function HeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const repositoryKey = readRepository(threadId) ?? undefined;
  const workspace = rpc.workspace.useQuery(
    { threadId, repositoryKey },
    { ...storedAnswer("workspace", { threadId, repositoryKey }), staleTime: 60_000 },
  );
  if (workspace.data?.state !== "ready") return null;
  return (
    // bb's own toolbar buttons (the editor picker beside this one) are an
    // outline button with this sizing, so the two read as one row of controls.
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 border-border/70 px-2 text-xs font-normal text-foreground shadow-none max-md:pointer-coarse:h-9"
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
    <PluginQueryBoundary>
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
