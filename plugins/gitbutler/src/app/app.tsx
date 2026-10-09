import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  UrlLink,
  definePluginApp,
  experimental_Icon as Icon,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import {
  PANEL_ACTION_ID,
  WORKSPACE_CHANGED_CHANNEL,
  workspaceChangedSchema,
} from "../shared/panel.ts";
import type { WorkspaceChanged } from "../shared/panel.ts";
import type {
  ActionRisk,
  PatchSource,
  Repository,
  Stack,
  Upstream,
  Workspace,
} from "../shared/schema.ts";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { Notice, WorkspaceSkeleton, errorText } from "./notice.tsx";
import {
  Confirm,
  pullRiskPrompt,
  refreshWorkspace,
  useButAction,
  useFocusAfter,
  writeBlocked,
} from "./branch-actions.tsx";
import type { WriteTarget } from "./branch-actions.tsx";
import { AskAgentButton, useAskAgent } from "./ask-agent.tsx";
import {
  BoardProvider,
  StatusLine,
  sameScope,
  useTransientStatus,
  useWriteBusy,
  writeScope,
} from "./board-context.tsx";
import type { WriteScope } from "./board-context.tsx";
import { Conflicts } from "./conflicts.tsx";
import { CopyButton } from "./copy-button.tsx";
import { FileCards } from "./file-cards.tsx";
import { GitButlerMark } from "./gitbutler-mark.tsx";
import { OperationHistory } from "./history-screen.tsx";
import { ParkedBranches } from "./parked-branches.tsx";
import { REFRESH_INTERVAL_MS } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { readStored, storedAnswer } from "./stored-queries.ts";
import { relativeTime, shortId, subject } from "./format.ts";
import { When } from "./when.tsx";
import {
  BaseCard,
  CommitExpansionContext,
  StackLane,
  UncommittedCard,
  stackKeys,
} from "./workspace-lane.tsx";
import type { CommitExpansion, CommitRef } from "./workspace-lane.tsx";
import "./gitbutler.css";

const REPOSITORY_STORAGE_PREFIX = "bb-plugin-gitbutler:repository:";
const HEADER_LABEL = "View in GitButler";
// GitButler's own install script and guide, as its CLI docs give them.
const INSTALL_COMMAND = "curl -fsSL https://gitbutler.com/install.sh | sh";
const INSTALL_DOCS = "https://docs.gitbutler.com/cli-guides/installation";

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
  | { kind: "uncommitted"; path: string }
  /** The changes assigned to one stack, named by its top branch. */
  | { kind: "assigned"; branch: string; paths: readonly string[]; path: string }
  | { kind: "history" };

const UNCOMMITTED_SOURCE: PatchSource = { kind: "uncommitted" };

function readRepository(threadId: string): string | null {
  try {
    return window.localStorage.getItem(`${REPOSITORY_STORAGE_PREFIX}${threadId}`);
  } catch {
    return null;
  }
}

/*
 * The header button and the panel are separate React trees, so a choice made
 * in the panel reaches the button through these listeners. A choice made in
 * another window arrives as a `storage` event.
 */
const repositoryListeners = new Set<() => void>();

function subscribeRepository(listener: () => void): () => void {
  repositoryListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    repositoryListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
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
  for (const listener of repositoryListeners) listener();
}

/** The repository chosen for a thread, kept current when the panel changes it. */
function useStoredRepository(threadId: string): string | null {
  return useSyncExternalStore(
    subscribeRepository,
    () => readRepository(threadId),
    () => null,
  );
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

/** A command the reader runs themselves, with a button that copies it whole. */
function CopyCommand({ command }: { command: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      <Command>{command}</Command>
      <CopyButton value={command} label="Copy command" />
    </span>
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

/** Quotes `but setup` to the agent. The panel itself never sets a repository up. */
function AskToRunSetup({ repoName }: { repoName: string }) {
  const ask = useAskAgent();
  if (!ask) return null;
  const where = repoName ? `the ${repoName} repository` : "this repository";
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-xs font-normal"
      onClick={() => ask(`Run \`but setup\` in ${where} to make it a GitButler project.`)}
    >
      <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
      Ask agent to run it
    </Button>
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
        icon="Terminal"
        title="The GitButler CLI is not installed here"
        detail={
          <>
            Install <Command>but</Command> on the machine hosting this environment, then refresh:{" "}
            <CopyCommand command={INSTALL_COMMAND} />
          </>
        }
        onRetry={onRetry}
        action={
          <UrlLink
            href={INSTALL_DOCS}
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            Install guide
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        }
      />
    );
  }
  if (workspace.state === "setupRequired") {
    return (
      <Notice
        icon="Settings"
        title="This repository is not a GitButler project"
        detail={
          <>
            Run <CopyCommand command="but setup" /> in the repository to start tracking it as a
            GitButler workspace, then refresh.
          </>
        }
        onRetry={onRetry}
        action={<AskToRunSetup repoName={workspace.repoName} />}
      />
    );
  }
  if (workspace.state === "noRepository") {
    return (
      <Notice
        icon="Folder"
        title="No repository in this environment"
        detail={detail}
        onRetry={onRetry}
      />
    );
  }
  if (workspace.state === "noEnvironment") {
    return (
      <Notice
        icon="Laptop"
        title="No project environment"
        detail={detail ?? "Attach this thread to an environment to see its GitButler workspace."}
      />
    );
  }
  return (
    <Notice
      icon="AlertTriangle"
      title="GitButler could not read this workspace"
      detail={detail}
      onRetry={onRetry}
    />
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

/** How a quote names a commit: its id, the change id `but` accepts, and its subject. */
function commitName(commit: CommitRef): string {
  const change = commit.changeId ? ` (change ${commit.changeId})` : "";
  return `${shortId(commit.commitId)}${change} "${subject(commit.message)}"`;
}

/*
 * History edits the reader can ask for. The panel never rewrites history, so
 * each one quotes the commit to the agent, which runs the `but` command.
 */
const COMMIT_ASKS: readonly { label: string; text: (name: string) => string }[] = [
  { label: "Reword", text: (name) => `Reword commit ${name} with \`but reword\`.` },
  {
    label: "Squash into parent",
    text: (name) => `Squash commit ${name} into its parent with \`but squash\`.`,
  },
  {
    label: "Move to another branch",
    text: (name) => `Move commit ${name} to another branch with \`but move\`.`,
  },
  { label: "Uncommit", text: (name) => `Uncommit ${name} with \`but uncommit\`.` },
];

/** The history edits for a commit in the workspace, each one a quote to the agent. */
function CommitAsks({ commit }: { commit: CommitRef }) {
  const ask = useAskAgent();
  // A commit on the target or a branch's remote is not the workspace's to rewrite.
  if (!ask || commit.where) return null;
  const name = commitName(commit);
  return (
    // A floated legend is laid out as a flex item, not drawn on the border.
    <fieldset className="m-0 mt-2 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <legend className="float-left me-0.5 p-0 text-[11px] text-muted-foreground">
        Ask agent to
      </legend>
      {COMMIT_ASKS.map((preset) => (
        <Button
          key={preset.label}
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs font-normal"
          onClick={() => ask(preset.text(name))}
        >
          {preset.label}
        </Button>
      ))}
    </fieldset>
  );
}

function CommitDetail({
  threadId,
  repositoryKey,
  workspace,
  selection,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  workspace: Workspace | undefined;
  selection: Extract<Selection, { kind: "commit" }>;
}) {
  const { commit } = selection;
  const source = useMemo<PatchSource>(
    () => ({
      kind: "commit",
      commitId: commit.commitId,
      ...(commit.where ? { where: commit.where } : {}),
    }),
    [commit.commitId, commit.where],
  );
  const title = subject(commit.message);
  // Everything under the subject: where an agent's commit says why.
  const body = commit.message.slice(title.length).trim();

  return (
    <>
      <div className="flex items-start gap-2">
        <h2 className="m-0 min-w-0 flex-1 text-sm font-semibold text-balance [overflow-wrap:anywhere]">
          {title}
        </h2>
        <AskAgentButton
          text={`Commit ${commitName(commit)}`}
          label={`Ask agent about commit ${shortId(commit.commitId)}`}
        />
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
        <span className="inline-flex items-center">
          <code className="font-mono">{shortId(commit.commitId)}</code>
          <CopyButton value={commit.commitId} label="Copy commit SHA" />
        </span>
        {commit.changeId ? (
          <span className="inline-flex items-center gap-1">
            change
            <code className="font-mono">{shortId(commit.changeId)}</code>
            <CopyButton value={commit.changeId} label="Copy change id" className="-ms-1" />
          </span>
        ) : null}
        <span>{commit.authorName}</span>
        <When value={commit.createdAt} />
      </p>
      {body ? (
        <p className="mt-2 whitespace-pre-wrap leading-normal text-muted-foreground [overflow-wrap:anywhere]">
          {body}
        </p>
      ) : null}
      <CommitAsks commit={commit} />
      <FileCards
        threadId={threadId}
        repositoryKey={repositoryKey}
        source={source}
        initialPath={selection.path}
        workspace={workspace}
      />
    </>
  );
}

/** What the detail screen draws under its Back button. */
function DetailContent({
  threadId,
  repositoryKey,
  workspace,
  selection,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  workspace: Workspace | undefined;
  selection: Selection;
}) {
  if (selection.kind === "history")
    return <OperationHistory target={{ threadId, repositoryKey }} />;
  if (selection.kind === "commit") {
    return (
      <CommitDetail
        threadId={threadId}
        repositoryKey={repositoryKey}
        workspace={workspace}
        selection={selection}
      />
    );
  }
  // One stack's assigned changes are the worktree's diff narrowed to its
  // files, so they share the uncommitted read.
  const assigned = selection.kind === "assigned" ? selection : null;
  return (
    <>
      <h2 className="m-0 text-sm font-semibold [overflow-wrap:anywhere]">
        {assigned ? `Assigned to ${assigned.branch}` : "Uncommitted"}
      </h2>
      <FileCards
        threadId={threadId}
        repositoryKey={repositoryKey}
        source={UNCOMMITTED_SOURCE}
        initialPath={selection.path}
        paths={assigned?.paths}
        workspace={workspace}
      />
    </>
  );
}

function DetailScreen({
  threadId,
  repositoryKey,
  workspace,
  selection,
  onBack,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  workspace: Workspace | undefined;
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
          aria-keyshortcuts="Escape"
          // The workspace under this screen goes inert and drops the focus,
          // so the focus starts here instead of on the page body.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onClick={onBack}
        >
          {/* bb has no ArrowLeft icon, and a missing name draws its fallback bolt. */}
          <Icon name="ChevronLeft" className="size-3" aria-hidden />
          Workspace
          {/* A touch screen has no Escape key to hint at. */}
          <kbd className="ms-1 font-mono text-[10px] text-subtle-foreground pointer-coarse:hidden">
            Esc
          </kbd>
        </Button>
      </header>
      <ScrollArea>
        <DetailContent
          threadId={threadId}
          repositoryKey={repositoryKey}
          workspace={workspace}
          selection={selection}
        />
      </ScrollArea>
    </div>
  );
}

function WorkspaceBody({
  threadId,
  repositoryKey,
  data,
  turnLeftWork,
  onOpenFile,
  onOpenAssigned,
  onRetry,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  data: Workspace;
  /** An agent's turn ended since the uncommitted files were last cleared. */
  turnLeftWork: boolean;
  onOpenFile: (path: string) => void;
  /** Opens a file assigned to `stack`, with only that stack's files beside it. */
  onOpenAssigned: (stack: Stack, path: string) => void;
  onRetry: () => void;
}) {
  if (data.state !== "ready") return <UnavailableWorkspace workspace={data} onRetry={onRetry} />;
  const target = { threadId, repositoryKey };
  const keys = stackKeys(data.stacks);
  return (
    <>
      <div className="flex flex-col gap-4">
        <Conflicts target={target} workspace={data} />
        <UncommittedCard
          changes={data.unassignedChanges}
          onOpenFile={onOpenFile}
          attention={turnLeftWork}
        />
        {data.stacks.map((stack, index) => (
          <StackLane
            key={keys[index]}
            target={target}
            stack={stack}
            onOpenFile={(path) => onOpenAssigned(stack, path)}
          />
        ))}
        {data.stacks.length === 0 ? (
          <Notice
            icon="GitBranch"
            title="No applied branches"
            detail="Apply a branch in GitButler, or ask the agent to start one. Applied branches show up here as stacks, with their commits."
          />
        ) : null}
        <ParkedBranches target={target} />
        {data.base ? (
          <BaseCard
            threadId={threadId}
            repositoryKey={repositoryKey}
            base={data.base}
            upstream={data.upstream}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * The header's Pull: `but pull` for the whole workspace, which rebases every
 * applied branch onto the target branch. It fetches first, so it also finds
 * commits the "behind" count has not heard of. It asks before leaving
 * conflicts, and says what happened in the status line.
 */
function useWorkspacePull(target: WriteTarget, behind: number, announce: (text: string) => void) {
  // The question or the refusal, tagged with the workspace it is about, so it
  // shows only there, and is still there when the reader comes back to it.
  // Not once the thread has moved to another environment: "Pull anyway"
  // there would accept risks read in the old one.
  const [outcome, setOutcome] = useState<{
    scope: WriteScope;
    question: ActionRisk | null;
    error: Error | null;
  } | null>(null);
  // Taken from the request and not the click, which loses its callbacks when
  // the reader switches repository while the pull runs.
  const action = useButAction(target, (result, error, scope) => {
    if (error) setOutcome({ scope, question: null, error });
    else if (result?.status === "confirm")
      setOutcome({ scope, question: result.risk, error: null });
    else if (result) announce(result.status === "upToDate" ? "Already up to date." : "Pulled");
  });
  const aim = writeScope(target, target.workspace ?? null);
  const shown = outcome && sameScope(outcome.scope, aim) ? outcome : null;
  const start = (accepted: ActionRisk | null) => {
    setOutcome(null);
    action.run({ kind: "updateWorkspace", accepted });
  };
  const { pending } = action;
  const cancel = useCallback(() => setOutcome(null), []);

  // A pull that went through another way, the agent's or GitButler's own,
  // leaves nothing to ask about or to refuse. Not while this pull is running:
  // its own refresh lands before it reports, and clearing then would drop
  // the report. Nor on a switch to a repository that is not behind, which
  // says nothing about the one the reader left.
  const seen = useRef({ key: target.repositoryKey, behind });
  useEffect(() => {
    const was = seen.current;
    seen.current = { key: target.repositoryKey, behind };
    if (was.key === target.repositoryKey && was.behind > 0 && behind === 0 && !pending) cancel();
  }, [behind, cancel, pending, target.repositoryKey]);

  return {
    start,
    cancel,
    pending,
    error: shown?.error ?? null,
    question: shown?.question ?? null,
  };
}

/**
 * The header's Pull. Its spinner tracks its own request, as Refresh's does.
 * With nothing to pull into it keeps its place unseen, so a poll that flips
 * the workspace's state does not shift Refresh and the title.
 */
const PullButton = forwardRef<
  HTMLButtonElement,
  { pull: ReturnType<typeof useWorkspacePull>; shown: boolean; blocked: string | null }
>(function PullButton({ pull, shown, blocked }, ref) {
  return (
    // A disabled button takes no hover, so what holds it says why.
    <span className="flex" title={(shown && blocked) || undefined}>
      <Button
        ref={ref}
        variant="outline"
        size="sm"
        className={cn("h-6 gap-1 px-2 text-xs font-normal", !shown && "invisible")}
        aria-label="Pull the target branch into the workspace"
        aria-hidden={shown ? undefined : true}
        tabIndex={shown ? undefined : -1}
        disabled={!shown || blocked !== null || pull.pending}
        onClick={() => pull.start(null)}
      >
        <Icon
          name={pull.pending ? "Spinner" : "ArrowDown"}
          className={cn("size-3", pull.pending && "animate-spin")}
          aria-hidden
        />
        Pull
      </Button>
    </span>
  );
});

/** The header's Pull button, which takes the focus back after a pull unless a question took it. */
function usePullFocus(pull: ReturnType<typeof useWorkspacePull>) {
  const button = useRef<HTMLButtonElement>(null);
  useFocusAfter(pull.pending, () => (pull.question ? null : button.current));
  return button;
}

/** Under the header: the Pull confirmation or its refusal. */
function WorkspacePullStatus({
  pull,
  pullButton,
  blocked,
}: {
  pull: ReturnType<typeof useWorkspacePull>;
  /** Where the focus goes back to when the reader backs out. */
  pullButton: RefObject<HTMLButtonElement | null>;
  blocked: string | null;
}) {
  const onCancel = () => {
    pull.cancel();
    pullButton.current?.focus();
  };
  const row = cn("shrink-0 border-b border-border px-2.5 py-1.5", GUTTER);
  return (
    <>
      {pull.question ? (
        <div className={row}>
          <Confirm
            prompt={pullRiskPrompt(pull.question)}
            label="Pull anyway"
            pending={pull.pending}
            blocked={blocked}
            onCancel={onCancel}
            onConfirm={() => pull.start(pull.question)}
          />
        </div>
      ) : pull.error ? (
        <div className={cn(row, "flex items-start gap-2")}>
          <p
            role="alert"
            className="m-0 min-w-0 flex-1 text-[11px] leading-normal text-destructive-text"
          >
            {pull.error.message}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground"
            aria-label="Dismiss"
            onClick={onCancel}
          >
            <Icon name="X" className="size-3" aria-hidden />
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Under the header while the board on screen is the last one that read cleanly. */
function StaleNote({ reason, onRetry }: { reason: string | null; onRetry: () => void }) {
  if (reason === null) return null;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-border px-2.5 py-1 text-[11px] text-muted-foreground",
        GUTTER,
      )}
    >
      <Icon name="AlertTriangle" className="size-3 shrink-0 text-attention" aria-hidden />
      <p className="m-0 min-w-0 flex-1">
        Couldn't refresh. Showing the last workspace.
        {reason ? (
          <span className="line-clamp-1 text-readback-foreground" title={reason}>
            {reason}
          </span>
        ) : null}
      </p>
      <Button
        variant="link"
        size="sm"
        className="h-auto shrink-0 p-0 text-[11px] font-normal"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
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

type ShownWorkspace = {
  data: Workspace | undefined;
  stale: string | null;
  /** Whether the board was read since the panel opened, not drawn from storage or memory. */
  live: boolean;
};

type LastReady = { repositoryKey: string | undefined; data: Workspace; live: boolean };

/** The last ready board for this repository, and whether it was read since the panel opened. */
function useLastReady(
  latest: Workspace | undefined,
  read: boolean,
  repositoryKey: string | undefined,
): LastReady | null {
  const [lastReady, setLastReady] = useState<LastReady | null>(null);
  // A first read that matches the stored board keeps its object, so the
  // check is on `live` as well as the data.
  if (latest?.state === "ready" && (latest !== lastReady?.data || (read && !lastReady.live))) {
    setLastReady({ repositoryKey, data: latest, live: read });
  }
  return lastReady?.repositoryKey === repositoryKey ? lastReady : null;
}

/**
 * The workspace to draw. A poll that fails after a good one keeps the board
 * the reader was using, with its open drafts and confirmations, and marks it
 * stale. Only a failure does: the other states are answers the reader has to
 * act on. The board kept is the current repository's, never another's. A
 * panel opened onto a failure has no board of its own yet, so the stored one
 * stands in.
 */
function useShownWorkspace(
  workspace: UseQueryResult<Workspace, Error>,
  threadId: string,
  repositoryKey: string | undefined,
): ShownWorkspace {
  const latest = workspace.data;
  const read = workspace.isFetchedAfterMount && !workspace.isRefetchError;
  const kept = useLastReady(latest, read, repositoryKey);
  const failed = latest?.state === "error" || (latest === undefined && workspace.isError);
  const fromStorage = failed && kept === null;
  const stored = useMemo(
    () => (fromStorage ? readStored("workspace", { threadId, repositoryKey }) : undefined),
    [fromStorage, threadId, repositoryKey],
  );
  const reason = latest?.state === "error" ? (latest.reason ?? "") : errorText(workspace.error);
  const keptLive = kept !== null && kept.data === latest && kept.live;
  if (failed && kept) return { data: kept.data, stale: reason, live: kept.live };
  if (failed && stored) return { data: stored, stale: reason, live: false };
  if (workspace.isRefetchError && latest?.state === "ready") {
    return { data: latest, stale: errorText(workspace.error), live: keptLive };
  }
  return { data: latest, stale: null, live: read || keptLive };
}

/**
 * A board drawn from storage or memory is checked as soon as the panel
 * opens. Until that first read lands, Refresh spins as if clicked, so a
 * board that is about to change says so.
 */
function checkingFirst(workspace: UseQueryResult<Workspace, Error>): boolean {
  return workspace.data !== undefined && workspace.isFetching && !workspace.isFetchedAfterMount;
}

/**
 * Reads the board again when an agent's turn ends on this environment, which
 * is how a subthread's commits reach its parent's panel, then calls
 * `onTurnEnded` with the signal once the new board is in. Signals sent while
 * the connection was down are lost, so a reconnect reads it again too.
 */
function useWorkspaceSignals(
  threadId: string,
  environmentId: string | null | undefined,
  onTurnEnded: (signal: WorkspaceChanged) => void,
): void {
  useRealtime(WORKSPACE_CHANGED_CHANNEL, (payload) => {
    const signal = workspaceChangedSchema.safeParse(payload);
    if (signal.success && environmentId && signal.data.environmentId === environmentId) {
      void refreshWorkspace(threadId).then(() => onTurnEnded(signal.data));
    }
  });
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    const was = previous.current;
    previous.current = connection;
    // The first connection comes from "connecting", which is not a reconnect.
    if (was === "reconnecting" && connection === "connected") void refreshWorkspace(threadId);
  }, [connection, threadId]);
}

/**
 * Whether an agent's turn on this repository ended with files left
 * uncommitted, for the Uncommitted card to flag. It clears once they are
 * committed, and another repository starts without it. Only this thread's
 * turns and its subthreads' count: another thread on the environment may
 * have touched nothing here, and the files may be the reader's own.
 */
function useTurnLeftWork(
  threadId: string,
  repositoryKey: string | undefined,
  data: Workspace | undefined,
): boolean {
  const [flagged, setFlagged] = useState<{ repositoryKey: string | undefined } | null>(null);
  useWorkspaceSignals(threadId, data?.environmentId, (signal) => {
    if (signal.threadId === threadId || signal.parentThreadId === threadId) {
      setFlagged({ repositoryKey });
    }
  });
  const left = flagged !== null && flagged.repositoryKey === repositoryKey;
  if (left && data?.state === "ready" && data.unassignedChanges.length === 0) setFlagged(null);
  return left;
}

/** The behind pill's hover text: how many, the newest one, and how fresh the count is. */
function behindTitle(upstream: Upstream): string {
  const parts = [`${upstream.behind} new on the target.`];
  if (upstream.latest) parts.push(`Latest: ${upstream.latest.subject}.`);
  const fetched = upstream.lastFetched ? relativeTime(upstream.lastFetched) : "";
  if (fetched) parts.push(`Fetched ${fetched}.`);
  return parts.join(" ");
}

function WorkspaceHeader({
  choices,
  repositoryKey,
  onChoose,
  data,
  pull,
  pullButton,
  pullBlocked,
  syncing,
  onRefresh,
  onHistory,
}: {
  choices: readonly Repository[] | undefined;
  repositoryKey: string | undefined;
  onChoose: (key: string) => void;
  data: Workspace | undefined;
  pull: ReturnType<typeof useWorkspacePull>;
  pullButton: RefObject<HTMLButtonElement | null>;
  /** Why Pull can't start now, or null. */
  pullBlocked: string | null;
  syncing: boolean;
  onRefresh: () => void;
  onHistory: () => void;
}) {
  const ready = data?.state === "ready";
  const upstream = data?.upstream ?? null;
  return (
    <header className={HEADER}>
      {choices && choices.length > 1 ? (
        <RepositoryPicker repositories={choices} value={repositoryKey} onChange={onChoose} />
      ) : (
        <span className="min-w-0 flex-1 truncate font-semibold" title={data?.repoName || undefined}>
          {data?.repoName || "GitButler"}
        </span>
      )}
      {upstream && upstream.behind > 0 ? (
        <Pill tone="text-warning-text" title={behindTitle(upstream)}>
          {`${upstream.behind} behind`}
        </Pill>
      ) : null}
      <PullButton ref={pullButton} pull={pull} shown={ready} blocked={pullBlocked} />
      {/* Kept in place unseen like Pull, for the same reason. */}
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-6 text-muted-foreground", !ready && "invisible")}
        aria-label="Operation history"
        aria-hidden={ready ? undefined : true}
        tabIndex={ready ? undefined : -1}
        disabled={!ready}
        onClick={onHistory}
      >
        <Icon name="Clock" className="size-3.5" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground"
        onClick={onRefresh}
        aria-label="Refresh"
        aria-busy={syncing}
        data-board-refresh
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
  );
}

/**
 * The workspace the board on screen was read from, and the target of a write
 * from the header. The header sits above the board, so it names the board's
 * workspace itself.
 */
function useBoardTarget(
  threadId: string,
  repositoryKey: string | undefined,
  data: Workspace | undefined,
) {
  const environmentId = data?.environmentId ?? null;
  const resolvedKey = data?.repositoryKey ?? null;
  return useMemo(() => {
    const identity = environmentId ? { environmentId, repositoryKey: resolvedKey } : null;
    return { identity, target: { threadId, repositoryKey, workspace: identity } };
  }, [environmentId, resolvedKey, threadId, repositoryKey]);
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
  // Here and not in the provider: the header's Pull announces from above it.
  const status = useTransientStatus();
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

  const openAssignedFile = useCallback(
    (stack: Stack, path: string) =>
      open({
        kind: "assigned",
        // The top branch, which a commit of these changes would land on.
        branch: stack.branches[0]?.name ?? stack.key,
        paths: stack.assignedChanges.map((change) => change.path),
        path,
      }),
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

  const { data, stale, live } = useShownWorkspace(workspace, threadId, repositoryKey);
  const turnLeftWork = useTurnLeftWork(threadId, repositoryKey, data);
  const { identity, target } = useBoardTarget(threadId, repositoryKey, data);
  const pull = useWorkspacePull(target, data?.upstream?.behind ?? 0, status.announce);
  const pullButton = usePullFocus(pull);
  const busy = useWriteBusy(target);
  // Asked here and not through the pull's own hook, which sits above the
  // board and so cannot see whether the board is live.
  const pullBlocked = writeBlocked(live, busy && !pull.pending);
  const refresh = () => {
    setRefreshing(true);
    void repositories.refetch();
    void refreshWorkspace(threadId).finally(() => setRefreshing(false));
  };
  const syncing = refreshing || checkingFirst(workspace);

  /*
   * The header is drawn in every state, loading and failure included. It used
   * to be skipped for both, which took Refresh away at exactly the moment a
   * reader needed it and left the failure with no way out of itself.
   */
  return (
    <BoardProvider live={live} workspace={identity} root={board} status={status}>
      <div className="relative h-full">
        <div
          ref={board}
          className={cn(SHELL, "outline-none")}
          tabIndex={-1}
          inert={selection !== null}
        >
          <WorkspaceHeader
            choices={repositories.data?.repositories}
            repositoryKey={repositoryKey}
            onChoose={chooseRepository}
            data={data}
            pull={pull}
            pullButton={pullButton}
            // A board read before the panel opened may be hours old, and so
            // may be what a pull would be aimed at.
            pullBlocked={pullBlocked}
            syncing={syncing}
            onRefresh={refresh}
            onHistory={() => open({ kind: "history" })}
          />
          <WorkspacePullStatus pull={pull} pullButton={pullButton} blocked={pullBlocked} />
          <StaleNote reason={stale} onRetry={refresh} />
          <ScrollArea>
            {data ? (
              <CommitExpansionContext.Provider value={expansion}>
                {/*
                 * Keyed by workspace: two repositories, or one thread's old and
                 * new environment, can share branch names, and a card's open
                 * confirmation or draft must not carry over to the same-named
                 * branch of the next one.
                 */}
                <WorkspaceBody
                  key={`${data.environmentId ?? ""}\n${data.repositoryKey ?? repositoryKey ?? ""}`}
                  threadId={threadId}
                  repositoryKey={repositoryKey}
                  data={data}
                  turnLeftWork={turnLeftWork}
                  onOpenFile={openUncommittedFile}
                  onOpenAssigned={openAssignedFile}
                  onRetry={refresh}
                />
              </CommitExpansionContext.Provider>
            ) : workspace.isError ? (
              <Notice
                icon="AlertCircle"
                title="GitButler could not be reached"
                detail={errorText(workspace.error)}
                onRetry={refresh}
              />
            ) : (
              <WorkspaceSkeleton label="Loading workspace…" />
            )}
          </ScrollArea>
          {/*
           * Over the bottom of the board, not a row of its own: a row that came
           * and went with every write moved each card under the pointer twice.
           * Clicks pass through to whatever it covers.
           */}
          <StatusLine
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden border-t border-border bg-background px-2.5 py-1.5",
              GUTTER,
            )}
          />
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
              workspace={data}
              selection={selection}
              onBack={back}
            />
          </div>
        ) : null}
      </div>
    </BoardProvider>
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
 * as the panel, so an open panel answers it from cache, and it follows the
 * panel's repository picker.
 */
function HeaderButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const repositoryKey = useStoredRepository(threadId) ?? undefined;
  const workspace = rpc.workspace.useQuery(
    { threadId, repositoryKey },
    { ...storedAnswer("workspace", { threadId, repositoryKey }), staleTime: 60_000 },
  );
  const state = workspace.data?.state;
  // A failed read is often a passing one. A workspace that has read cleanly
  // before keeps its button through it, as the panel keeps its board.
  const readyBefore = useMemo(
    () => state === "error" && readStored("workspace", { threadId, repositoryKey }) !== undefined,
    [state, threadId, repositoryKey],
  );
  if (state !== "ready" && !readyBefore) return null;
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
