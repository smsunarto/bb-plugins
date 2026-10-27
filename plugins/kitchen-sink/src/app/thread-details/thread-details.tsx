import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtimeConnectionState,
  useSdk,
  type PluginSidebarThread,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { z } from "zod";

import type {
  AgentGitAction,
  ProjectScript,
  ProjectScriptEdit,
} from "../../shared/thread-details.ts";
import { rpc } from "../rpc.ts";
import {
  InfoRow,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Row,
  RowIcon,
  RowLabel,
  Section,
  SelectRow,
  SplitPrimary,
  SplitRow,
  PORTAL_SCOPE,
  cx,
} from "./rows.tsx";
import { ScriptDialog, type ScriptDraft } from "./script-dialog.tsx";

export const THREAD_DETAILS_TITLE = "Thread details";

/** The slice of bb--github-pr-status's contract this card reads and writes. */
const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
    // The plugin's own tags, so a read this card starts still refreshes on its writes.
    keyTags: (environmentId) => [environmentTag(environmentId)],
  },
  markReady: {
    input: z.object({ environmentId: z.string() }),
    output: z.object({ message: z.string() }),
    invalidates: ({ environmentId }) => [environmentTag(environmentId)],
  },
  markDraft: {
    input: z.object({ environmentId: z.string() }),
    output: z.object({ message: z.string() }),
    invalidates: ({ environmentId }) => [environmentTag(environmentId)],
  },
});

function environmentTag(environmentId: string) {
  return `environment:${environmentId}`;
}

type ThreadEnvironment = NonNullable<PluginSidebarThread["environment"]>;

interface ChangeStats {
  insertions: number;
  deletions: number;
  fileCount: number;
  /** "uncommitted" counts the working tree; "branch" counts commits since the merge base. */
  scope: "uncommitted" | "branch";
}

type StatusEntry =
  | { state: "loading" }
  | {
      state: "ready";
      changes: ChangeStats | null;
      branch: string | null;
      /** Set when the checkout is not a git repository. */
      notGit?: true;
      at: number;
    }
  | { state: "failed"; message: string; last: Extract<StatusEntry, { state: "ready" }> | null };

/**
 * Environment status survives the card closing, so a reopened card draws the
 * last answer at once and refreshes behind it. Keyed by environment id.
 */
const statusCache = new Map<string, StatusEntry>();
const statusListeners = new Set<() => void>();
function setStatus(environmentId: string, entry: StatusEntry) {
  statusCache.set(environmentId, entry);
  for (const listener of statusListeners) listener();
}
function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** A sleeping checkout host must not leave the row spinning. */
const STATUS_TIMEOUT_MS = 8_000;

function useEnvironmentStatus(environmentId: string | null, open: boolean) {
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const entry = useSyncExternalStore(subscribeStatus, () =>
    environmentId === null ? undefined : statusCache.get(environmentId),
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || environmentId === null || connection !== "connected") return;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STATUS_TIMEOUT_MS);
    const previous = statusCache.get(environmentId);
    const last =
      previous?.state === "ready" ? previous : previous?.state === "failed" ? previous.last : null;
    if (!last) setStatus(environmentId, { state: "loading" });
    const read = async () => {
      try {
        const response = await sdk.environments.status({
          environmentId,
          signal: controller.signal,
        });
        if (response.outcome === "unavailable")
          setStatus(environmentId, { state: "failed", message: response.failure.message, last });
        else setStatus(environmentId, readyStatus(response));
      } catch (error) {
        // A card that closed or moved on cancels its read; only a timeout or a refusal is a failure.
        if (controller.signal.aborted && !timedOut) return;
        const message = timedOut ? "The checkout's machine did not answer." : errorMessage(error);
        setStatus(environmentId, { state: "failed", message, last });
      } finally {
        clearTimeout(timer);
      }
    };
    void read();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sdk, environmentId, open, connection, attempt]);
  return {
    entry,
    offline: connection !== "connected",
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  };
}

type EnvironmentStatusResponse = Awaited<
  ReturnType<ReturnType<typeof useSdk>["environments"]["status"]>
>;

function readyStatus(
  response: Exclude<EnvironmentStatusResponse, { outcome: "unavailable" }>,
): Extract<StatusEntry, { state: "ready" }> {
  if (response.outcome === "not_applicable")
    return { state: "ready", changes: null, branch: null, notGit: true, at: Date.now() };
  const { workingTree, mergeBase, branch } = response.workspace;
  // Uncommitted work is what the agent just did; a clean tree falls back to the branch's commits.
  const changes: ChangeStats | null =
    workingTree.fileCount > 0
      ? { ...pickStats(workingTree), scope: "uncommitted" }
      : mergeBase && mergeBase.fileCount > 0
        ? { ...pickStats(mergeBase), scope: "branch" }
        : null;
  return { state: "ready", changes, branch: branch.currentBranch, at: Date.now() };
}

function pickStats(stats: { insertions: number; deletions: number; fileCount: number }) {
  return {
    insertions: stats.insertions,
    deletions: stats.deletions,
    fileCount: stats.fileCount,
  };
}

const numberFormat = new Intl.NumberFormat();

export function ThreadDetailsHeaderAction(props: PluginThreadHeaderActionProps) {
  return (
    <PluginQueryBoundary>
      <ThreadDetails key={props.threadId} {...props} />
    </PluginQueryBoundary>
  );
}

type ScriptEditor = { script: ProjectScript | null } | null;

/** What the card knows about the project's scripts; edits are offered only from a confirmed list. */
export type ScriptsState =
  | { state: "loading" }
  | { state: "failed"; message: string; retry(): void }
  | { state: "ready"; scripts: readonly ProjectScript[] };

function ThreadDetails({ threadId, projectId }: PluginThreadHeaderActionProps) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<ScriptEditor>(null);
  // Kept here, not in the card, so it survives the card closing when a script's terminal opens.
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sidebar = useSidebarThreads();
  const thread = sidebar.threads.find((candidate) => candidate.id === threadId) ?? null;
  const project = sidebar.projects.find((candidate) => candidate.id === projectId) ?? null;
  const scriptsInput = { projectId };
  const scripts = rpc.projectScripts.useQuery(scriptsInput, {
    enabled: open || editor !== null,
    staleTime: 30_000,
  });
  const save = rpc.saveProjectScript.useMutation({
    onSuccess: (result) =>
      pluginQueryClient.setQueryData(rpc.projectScripts.queryKey(scriptsInput), result),
  });
  const saveEdit = (edit: ProjectScriptEdit, done: string) =>
    save.mutate(
      { projectId, edit },
      {
        onSuccess: () => {
          setEditor(null);
          toast.success(done);
        },
        onError: (error) =>
          toast.error("Could not save the script", { description: error.message }),
      },
    );
  const scriptsState: ScriptsState = scripts.isSuccess
    ? { state: "ready", scripts: scripts.data.scripts }
    : scripts.isError
      ? { state: "failed", message: scripts.error.message, retry: () => void scripts.refetch() }
      : { state: "loading" };
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={THREAD_DETAILS_TITLE}
            className={cx(
              "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:size-9",
              open && "bg-foreground/[0.06] text-foreground",
            )}
          >
            <Icon name="AlignLeft" aria-hidden className="size-4" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            {...PORTAL_SCOPE}
            align="end"
            sideOffset={8}
            collisionPadding={8}
            aria-label={THREAD_DETAILS_TITLE}
            // Focus the card, not its first row, so opening by pointer shows no ring; Tab still enters the rows.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
            className="z-40 w-[min(280px,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-border/70 bg-popover/95 text-popover-foreground shadow-xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          >
            <div className="max-h-[min(calc(100dvh-6.5rem),calc(var(--radix-popover-content-available-height)-0.5rem))] overflow-y-auto">
              {thread ? (
                <DetailsCard
                  threadId={threadId}
                  thread={thread}
                  scripts={scriptsState}
                  lastRunId={lastRunId}
                  onRunScript={setLastRunId}
                  onEditScript={(script) => {
                    setOpen(false);
                    setEditor({ script });
                  }}
                  open={open}
                />
              ) : (
                <ThreadMissing status={sidebar.status} />
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {editor ? (
        <ScriptDialog
          script={editor.script}
          projectName={project?.name ?? null}
          pending={save.isPending}
          returnFocus={trigger}
          onClose={() => setEditor(null)}
          onDelete={() => {
            const target = editor.script;
            if (target) saveEdit({ kind: "delete", scriptId: target.id }, `Deleted ${target.name}`);
          }}
          onSave={(draft: ScriptDraft) => {
            const target = editor.script;
            saveEdit(
              { kind: "upsert", script: { id: target?.id ?? crypto.randomUUID(), ...draft } },
              target ? `Saved ${draft.name}` : `Added ${draft.name}`,
            );
          }}
        />
      ) : null}
    </>
  );
}

function DetailsCard({
  threadId,
  thread,
  scripts,
  lastRunId,
  onRunScript,
  onEditScript,
  open,
}: {
  threadId: string;
  thread: PluginSidebarThread;
  scripts: ScriptsState;
  lastRunId: string | null;
  onRunScript(scriptId: string): void;
  onEditScript(script: ProjectScript | null): void;
  open: boolean;
}) {
  const environment = thread.environment?.id ? thread.environment : null;
  const hostId = thread.host?.id ?? null;
  const { entry, offline, retry } = useEnvironmentStatus(environment?.id ?? null, open);
  const status = entry?.state === "ready" ? entry : entry?.state === "failed" ? entry.last : null;
  const branch = status?.branch ?? environment?.branchName ?? null;
  return (
    <>
      <Section label="Workspace" separated={false}>
        <MachineRow thread={thread} environment={environment} threadId={threadId} />
        {environment?.path && hostId ? (
          <OpenInEditorRow hostId={hostId} path={environment.path} />
        ) : null}
        {environment ? (
          <ScriptsRow
            threadId={threadId}
            scripts={scripts}
            lastRunId={lastRunId}
            onRun={onRunScript}
            onEdit={onEditScript}
          />
        ) : null}
      </Section>
      {environment ? (
        <Section label="Version control">
          {branch ? <BranchRow branch={branch} /> : null}
          {status?.notGit ? null : (
            <PullRequestRow threadId={threadId} environmentId={environment.id!} open={open} />
          )}
          <ChangesRow entry={entry} status={status} offline={offline} onRetry={retry} />
        </Section>
      ) : null}
    </>
  );
}

/** A terminal pending to open, so a slow host is not asked twice; one that cannot be shown is closed. */
function useThreadTerminal(threadId: string) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const open = async (
    options: { title?: string; command?: string },
    failure: string,
  ): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      const terminal = await sdk.terminals.create({
        scope: { kind: "thread", threadId },
        cols: 120,
        rows: 32,
        ...(options.title ? { title: options.title } : {}),
        ...(options.command ? { start: { mode: "command", command: options.command } } : {}),
      });
      if (await navigate.experimental_openTerminal({ terminalId: terminal.id })) return;
      // A script nobody can see should not keep running.
      await sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => undefined);
      toast.error("This view has no terminal panel.");
    } catch (error) {
      toast.error(failure, { description: errorMessage(error) });
    } finally {
      setPending(false);
    }
  };
  return { pending, open };
}

function MachineRow({
  thread,
  environment,
  threadId,
}: {
  thread: PluginSidebarThread;
  environment: ThreadEnvironment | null;
  threadId: string;
}) {
  const terminal = useThreadTerminal(threadId);
  const machine = thread.host?.name ?? "No machine";
  const icons = (
    <span className="flex shrink-0 items-center gap-1">
      <RowIcon name="Laptop" />
      <RowIcon name={environment?.isWorktree ? "FolderGit" : "Folder"} />
    </span>
  );
  if (!environment) {
    return (
      <InfoRow>
        {icons}
        <RowLabel>{machine}</RowLabel>
      </InfoRow>
    );
  }
  return (
    <SelectRow icon={icons} label={machine}>
      <MenuLabel>{environment.isWorktree ? "Worktree" : "Checkout"}</MenuLabel>
      {environment.path ? (
        <MenuItem
          icon="Copy"
          detail={environment.path}
          onSelect={() => void copy(environment.path!, "Copied the path")}
        >
          Copy path
        </MenuItem>
      ) : null}
      <MenuItem
        icon="Terminal"
        disabled={terminal.pending}
        onSelect={() => void terminal.open({}, "Could not open a terminal")}
      >
        Open terminal
      </MenuItem>
    </SelectRow>
  );
}

function OpenInEditorRow({ hostId, path }: { hostId: string; path: string }) {
  const navigate = useBbNavigate();
  // bb queues the folder for this client's preferred external target and reports failures itself.
  return (
    <Row
      onClick={() =>
        navigate.experimental_openFileExternally({
          target: { kind: "host", hostId, path },
          location: null,
        })
      }
    >
      <RowIcon name="Code" />
      <RowLabel>Open in editor</RowLabel>
    </Row>
  );
}

function ScriptsRow({
  threadId,
  scripts: state,
  lastRunId,
  onRun,
  onEdit,
}: {
  threadId: string;
  scripts: ScriptsState;
  lastRunId: string | null;
  onRun(scriptId: string): void;
  onEdit(script: ProjectScript | null): void;
}) {
  const terminal = useThreadTerminal(threadId);
  if (state.state === "loading") {
    return (
      <InfoRow className="text-muted-foreground">
        <RowIcon name="Play" />
        <RowLabel>Loading scripts…</RowLabel>
      </InfoRow>
    );
  }
  if (state.state === "failed") {
    return (
      <Row title={state.message} onClick={state.retry}>
        <RowIcon name="Play" />
        <RowLabel>
          <span className="text-muted-foreground">Scripts unavailable</span>
        </RowLabel>
        <span className="shrink-0 text-xs text-muted-foreground">Retry</span>
      </Row>
    );
  }
  const { scripts } = state;
  const run = (script: ProjectScript) => {
    onRun(script.id);
    void terminal.open(
      { title: script.name, command: script.command },
      `Could not run ${script.name}`,
    );
  };
  const preferred = scripts.find((script) => script.id === lastRunId) ?? scripts[0];
  if (!preferred) {
    return (
      <Row onClick={() => onEdit(null)}>
        <RowIcon name="Plus" />
        <RowLabel>Add project script</RowLabel>
      </Row>
    );
  }
  return (
    <SplitRow
      primary={
        <SplitPrimary disabled={terminal.pending} onClick={() => run(preferred)}>
          <RowIcon name="Play" />
          <RowLabel>Run {preferred.name}</RowLabel>
        </SplitPrimary>
      }
      menuLabel="Project scripts"
      menu={
        <>
          <MenuLabel>Run</MenuLabel>
          {scripts.map((script) => (
            <MenuItem
              key={script.id}
              icon="Play"
              detail={script.command}
              disabled={terminal.pending}
              onSelect={() => run(script)}
            >
              {script.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          {scripts.map((script) => (
            <MenuItem key={`edit-${script.id}`} icon="Edit" onSelect={() => onEdit(script)}>
              Edit {script.name}
            </MenuItem>
          ))}
          <MenuItem icon="Plus" onSelect={() => onEdit(null)}>
            Add project script
          </MenuItem>
        </>
      }
    />
  );
}

function BranchRow({ branch }: { branch: string }) {
  return (
    <SelectRow icon={<RowIcon name="GitBranch" />} label={branch}>
      <MenuItem icon="Copy" onSelect={() => void copy(branch, "Copied the branch name")}>
        Copy branch name
      </MenuItem>
    </SelectRow>
  );
}

type PullRequest = { number: number; title: string; url: string; state: "open" | "draft" };

function PullRequestRow({
  threadId,
  environmentId,
  open,
}: {
  threadId: string;
  environmentId: string;
  open: boolean;
}) {
  const pullRequests = useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: open ? [environmentId] : [],
  });
  const ask = rpc.askAgent.useMutation();
  const askAgent = (action: AgentGitAction, label: string) =>
    ask.mutate(
      { threadId, action },
      {
        onSuccess: () => toast.success(`Asked the agent to ${label}`),
        onError: (error) =>
          toast.error("Could not message the agent", { description: error.message }),
      },
    );
  const row = pullRequests.data?.[environmentId];
  if (row?.outcome === "available") {
    const { pullRequest } = row;
    // A merged or closed pull request leaves the branch free for a new one.
    if (pullRequest.state === "open" || pullRequest.state === "draft")
      return (
        <OpenPullRequestRow
          environmentId={environmentId}
          pullRequest={pullRequest as PullRequest}
          asking={ask.isPending}
          onAsk={askAgent}
        />
      );
    return <PushRow asking={ask.isPending} onAsk={askAgent} />;
  }
  if (row?.outcome === "absent") return <PushRow asking={ask.isPending} onAsk={askAgent} />;
  // Until GitHub answers, offering "create" could open a second pull request for the branch.
  const failure = row?.outcome === "unavailable" ? row.message : pullRequests.error?.message;
  if (failure === undefined) {
    return (
      <InfoRow className="text-muted-foreground">
        <RowIcon name="GitPullRequest" />
        <RowLabel>Checking pull request…</RowLabel>
      </InfoRow>
    );
  }
  return (
    <Row title={failure} onClick={() => void pullRequests.refetch()}>
      <RowIcon name="GitPullRequest" />
      <RowLabel>
        <span className="text-muted-foreground">Pull request status unavailable</span>
      </RowLabel>
      <span className="shrink-0 text-xs text-muted-foreground">Retry</span>
    </Row>
  );
}

function OpenPullRequestRow({
  environmentId,
  pullRequest,
  asking,
  onAsk,
}: {
  environmentId: string;
  pullRequest: PullRequest;
  asking: boolean;
  onAsk(action: AgentGitAction, label: string): void;
}) {
  const navigate = useBbNavigate();
  const draft = pullRequest.state === "draft";
  const flipState = useRpcMutation({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: draft ? "markReady" : "markDraft",
  });
  const flip = async () => {
    try {
      await flipState.mutate({ environmentId });
      toast.success(draft ? "Marked ready for review" : "Converted to draft");
    } catch (error) {
      toast.error("GitHub refused the change", { description: errorMessage(error) });
    }
  };
  return (
    <SplitRow
      primary={
        <SplitPrimary title={pullRequest.title} onClick={() => navigate.openUrl(pullRequest.url)}>
          <RowIcon name={draft ? "GitPullRequestDraft" : "GitPullRequest"} />
          <RowLabel>
            {draft ? "Draft" : "View"} PR #{pullRequest.number}
          </RowLabel>
        </SplitPrimary>
      }
      menuLabel="Pull request actions"
      menu={
        <>
          <MenuLabel>{pullRequest.title}</MenuLabel>
          <MenuItem
            icon="Bot"
            disabled={asking}
            onSelect={() => onAsk("update-pr", "update the pull request")}
          >
            Push & update PR
          </MenuItem>
          <MenuItem
            icon={draft ? "CircleCheck" : "GitPullRequestDraft"}
            disabled={flipState.isPending}
            onSelect={() => void flip()}
          >
            {draft ? "Mark ready for review" : "Convert to draft"}
          </MenuItem>
          <MenuItem
            icon="Copy"
            onSelect={() => void copy(pullRequest.url, "Copied the pull request link")}
          >
            Copy link
          </MenuItem>
        </>
      }
    />
  );
}

function PushRow({
  asking,
  onAsk,
}: {
  asking: boolean;
  onAsk(action: AgentGitAction, label: string): void;
}) {
  const pushAndOpen = () => onAsk("push-and-create-pr", "push and open a pull request");
  return (
    <SplitRow
      primary={
        <SplitPrimary disabled={asking} onClick={pushAndOpen}>
          <RowIcon name="Github" />
          <RowLabel>Push & create PR</RowLabel>
        </SplitPrimary>
      }
      menuLabel="Git actions"
      menu={
        <>
          <MenuLabel>Ask the agent to</MenuLabel>
          <MenuItem icon="Check" disabled={asking} onSelect={() => onAsk("commit", "commit")}>
            Commit
          </MenuItem>
          <MenuItem icon="ArrowUp" disabled={asking} onSelect={() => onAsk("push", "push")}>
            Push
          </MenuItem>
          <MenuItem icon="GitPullRequest" disabled={asking} onSelect={pushAndOpen}>
            Push & create PR
          </MenuItem>
        </>
      }
    />
  );
}

function ChangesRow({
  entry,
  status,
  offline,
  onRetry,
}: {
  entry: StatusEntry | undefined;
  status: Extract<StatusEntry, { state: "ready" }> | null;
  offline: boolean;
  onRetry(): void;
}) {
  const changes = status?.changes ?? null;
  const label = changes?.scope === "branch" ? "Branch changes" : "Changes";
  const stats = changes ? (
    <span
      className="shrink-0 font-mono text-xs tabular-nums"
      title={`${changes.fileCount} ${changes.fileCount === 1 ? "file" : "files"}`}
    >
      <span className="text-[color:var(--diff-added,var(--color-green-500))]">
        +{numberFormat.format(changes.insertions)}
      </span>{" "}
      <span className="text-destructive">-{numberFormat.format(changes.deletions)}</span>
    </span>
  ) : null;
  if (entry?.state === "failed") {
    return (
      <Row title={entry.message} onClick={onRetry}>
        <RowIcon name="FileDiff" />
        <RowLabel>
          <span className="text-muted-foreground">
            {status ? `${label} (stale)` : "Changes unavailable"}
          </span>
        </RowLabel>
        {stats ?? <span className="shrink-0 text-xs text-muted-foreground">Retry</span>}
      </Row>
    );
  }
  const text = changesText(status, label, offline);
  return (
    <InfoRow className="text-muted-foreground">
      <RowIcon name="FileDiff" />
      <RowLabel>{text}</RowLabel>
      {stats}
    </InfoRow>
  );
}

function changesText(
  status: Extract<StatusEntry, { state: "ready" }> | null,
  label: string,
  offline: boolean,
): string {
  if (status?.notGit) return "Not a git checkout";
  if (!status) return offline ? "Changes unavailable offline" : "Checking changes…";
  if (!status.changes) return "No changes";
  return offline ? `${label} (offline)` : label;
}

function ThreadMissing({ status }: { status: string }) {
  const text =
    status === "error"
      ? "Could not load this thread's details."
      : status === "loading"
        ? "Loading…"
        : "Details are shown for active threads.";
  return <p className="px-4 py-3 text-[13px] text-muted-foreground">{text}</p>;
}

async function copy(text: string, done: string) {
  const ok = await copyToClipboard({ text }).catch(() => false);
  if (ok) toast.success(done);
  else toast.error("Could not copy to the clipboard.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
