import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSdk,
  type PluginSidebarThread,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import type { ProjectScript, ProjectScriptEdit } from "../../shared/thread-details.ts";
import { queryClient } from "../query.ts";
import { queryKey, useRpcMutation as usePluginMutation, useRpcQuery } from "../rpc.ts";
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
import { useStreamDock, type StreamDockLayout } from "./stream-dock.ts";

export const THREAD_DETAILS_TITLE = "Thread details";

const CARD_CLASS =
  "w-[min(280px,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-foreground/10 bg-popover/95 text-popover-foreground backdrop-blur-xl outline-none";

type ThreadEnvironment = NonNullable<PluginSidebarThread["environment"]>;

export function ThreadDetailsHeaderAction(props: PluginThreadHeaderActionProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThreadDetails key={props.threadId} {...props} />
    </QueryClientProvider>
  );
}

type ScriptEditor = { script: ProjectScript | null } | null;

/** What the card knows about the project's scripts; edits are offered only from a confirmed list. */
export type ScriptsState =
  | { state: "loading" }
  | { state: "failed"; message: string; retry(): void }
  | { state: "ready"; scripts: readonly ProjectScript[] };

function ThreadDetails({ threadId, projectId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLElement>(null);
  const cardId = useId();
  const layout = useStreamDock(anchor);
  const open = layout !== null && !isCompactViewport;
  const [editor, setEditor] = useState<ScriptEditor>(null);
  // Keep the last run across card layout changes.
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const sidebar = useSidebarThreads();
  const thread = sidebar.threads.find((candidate) => candidate.id === threadId) ?? null;
  const project = sidebar.projects.find((candidate) => candidate.id === projectId) ?? null;
  const { scriptsState, saveEdit, saving } = useProjectScripts(
    projectId,
    open || editor !== null,
    () => setEditor(null),
  );
  const details = thread ? (
    <DetailsCard
      threadId={threadId}
      thread={thread}
      scripts={scriptsState}
      lastRunId={lastRunId}
      onRunScript={setLastRunId}
      onEditScript={(script) => {
        setEditor({ script });
      }}
    />
  ) : (
    <ThreadMissing status={sidebar.status} />
  );
  return (
    <>
      <span ref={anchor} className="inline-block h-7 w-0">
        {open ? (
          <a
            href={`#${cardId}`}
            className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-popover focus:p-2"
            onClick={(event) => {
              event.preventDefault();
              card.current?.focus();
            }}
          >
            Go to thread details
          </a>
        ) : null}
      </span>
      {layout && open ? (
        <DockedCard id={cardId} layout={layout} cardRef={card}>
          {details}
        </DockedCard>
      ) : null}
      {editor ? (
        <ScriptDialog
          script={editor.script}
          projectName={project?.name ?? null}
          pending={saving}
          returnFocus={card}
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

/** The project's scripts, read while the card or the script editor needs them. */
function useProjectScripts(projectId: string, enabled: boolean, onSaved: () => void) {
  const scriptsInput = { projectId };
  const scripts = useRpcQuery("projectScripts", scriptsInput, { enabled, staleTime: 30_000 });
  const save = usePluginMutation("saveProjectScript", {
    onSuccess: (result) =>
      queryClient.setQueryData(queryKey("projectScripts", scriptsInput), result),
  });
  const saveEdit = (edit: ProjectScriptEdit, done: string) =>
    save.mutate(
      { projectId, edit },
      {
        onSuccess: () => {
          onSaved();
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
  return { scriptsState, saveEdit, saving: save.isPending };
}

/** The card floating over the top right of bb's thread stream, below the header. */
function DockedCard({
  id,
  layout,
  children,
  cardRef,
}: {
  id: string;
  layout: StreamDockLayout;
  children: ReactNode;
  cardRef: RefObject<HTMLElement | null>;
}) {
  return createPortal(
    <section
      {...PORTAL_SCOPE}
      ref={cardRef}
      tabIndex={-1}
      id={id}
      aria-label={THREAD_DETAILS_TITLE}
      style={{
        width: layout.width,
        top: layout.top,
        right: layout.right,
        maxHeight: layout.maxHeight,
      }}
      className={cx(
        CARD_CLASS,
        "fixed z-30 flex origin-top-right flex-col animate-in fade-in-0 zoom-in-95",
      )}
    >
      <div className="min-h-0 overflow-y-auto">{children}</div>
    </section>,
    document.body,
  );
}

function DetailsCard({
  threadId,
  thread,
  scripts,
  lastRunId,
  onRunScript,
  onEditScript,
}: {
  threadId: string;
  thread: PluginSidebarThread;
  scripts: ScriptsState;
  lastRunId: string | null;
  onRunScript(scriptId: string): void;
  onEditScript(script: ProjectScript | null): void;
}) {
  const environment = thread.environment?.id ? thread.environment : null;
  return (
    <>
      <Section label="Workspace" separated={false}>
        <MachineRow thread={thread} environment={environment} threadId={threadId} />
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
  const icon = <RowIcon name="Laptop" />;
  if (!environment) {
    return (
      <InfoRow>
        {icon}
        <RowLabel>{machine}</RowLabel>
      </InfoRow>
    );
  }
  return (
    <SelectRow icon={icon} label={machine}>
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
