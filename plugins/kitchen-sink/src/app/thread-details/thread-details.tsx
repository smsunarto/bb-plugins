import {
  experimental_ThreadContextCardRow as CardRow,
  experimental_copyToClipboard as copyToClipboard,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSdk,
  type ExperimentalThreadContextCardProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import type { ProjectScript, ProjectScriptEdit } from "../../shared/thread-details.ts";
import { queryClient } from "../query.ts";
import { queryKey, useRpcMutation as usePluginMutation, useRpcQuery } from "../rpc.ts";
import { MenuItem, MenuLabel, MenuSeparator, RowMenu } from "./rows.tsx";
import { ScriptDialog, type ScriptDraft } from "./script-dialog.tsx";

type ThreadEnvironment = NonNullable<PluginSidebarThread["environment"]>;

type CardProps = ExperimentalThreadContextCardProps;

/** bb's thread context card rows for the thread's machine and the project's scripts. */
export function WorkspaceRows(props: CardProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace key={props.threadId} {...props} />
    </QueryClientProvider>
  );
}

/** What the card knows about the project's scripts; edits are offered only from a confirmed list. */
export type ScriptsState =
  | { state: "loading" }
  | { state: "failed"; message: string; retry(): void }
  | { state: "ready"; scripts: readonly ProjectScript[] };

function useSidebarThread(threadId: string) {
  const sidebar = useSidebarThreads();
  return {
    thread: sidebar.threads.find((candidate) => candidate.id === threadId) ?? null,
    projects: sidebar.projects,
  };
}

/*
 * bb unmounts the card's rows whenever its narrow-pane popover closes, which a
 * row click does, and when the pane crosses the wide/narrow breakpoint. State
 * that must outlive one mount lives here, keyed by thread, and the script
 * editor renders from an app overlay rather than from the rows.
 */
const lastRunByThread = new Map<string, string>();

interface ScriptEditorRequest {
  threadId: string;
  projectId: string;
  projectName: string | null;
  /** The script being edited, or null to add one. */
  script: ProjectScript | null;
  /** Focus target after closing, when it is still in the document. */
  returnFocus: HTMLElement | null;
}

let editorRequest: ScriptEditorRequest | null = null;
const editorListeners = new Set<() => void>();
function setEditorRequest(request: ScriptEditorRequest | null) {
  editorRequest = request;
  for (const listener of editorListeners) listener();
}
function subscribeEditor(listener: () => void) {
  editorListeners.add(listener);
  return () => editorListeners.delete(listener);
}

function Workspace({ threadId, projectId }: CardProps) {
  const { thread, projects } = useSidebarThread(threadId);
  const checkout = thread?.environment?.id ? thread.environment : null;
  const [lastRunId, setLastRunId] = useState(() => lastRunByThread.get(threadId) ?? null);
  const scriptsMenu = useRef<HTMLButtonElement>(null);
  const scriptsState = useProjectScripts(projectId, checkout !== null);
  if (!thread) return null;
  const projectName = projects.find((candidate) => candidate.id === projectId)?.name ?? null;
  return (
    <>
      <MachineRow thread={thread} checkout={checkout} threadId={threadId} />
      {checkout ? (
        <ScriptsRow
          threadId={threadId}
          scripts={scriptsState}
          lastRunId={lastRunId}
          menuRef={scriptsMenu}
          onRun={(scriptId) => {
            lastRunByThread.set(threadId, scriptId);
            setLastRunId(scriptId);
          }}
          onEdit={(script) =>
            setEditorRequest({
              threadId,
              projectId,
              projectName,
              script,
              // The menu's trigger after an edit; the clicked row after Add.
              returnFocus:
                scriptsMenu.current ??
                (document.activeElement instanceof HTMLElement ? document.activeElement : null),
            })
          }
        />
      ) : null}
    </>
  );
}

/** The project's scripts, read while the rows need them. */
function useProjectScripts(projectId: string, enabled: boolean): ScriptsState {
  const scripts = useRpcQuery("projectScripts", { projectId }, { enabled, staleTime: 30_000 });
  return scripts.isSuccess
    ? { state: "ready", scripts: scripts.data.scripts }
    : scripts.isError
      ? { state: "failed", message: scripts.error.message, retry: () => void scripts.refetch() }
      : { state: "loading" };
}

/** App overlay: the open script editor, which outlives the card rows that opened it. */
export function ScriptEditorOverlay() {
  const request = useSyncExternalStore(subscribeEditor, () => editorRequest);
  if (!request) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <ScriptEditor key={`${request.threadId}:${request.script?.id ?? "new"}`} request={request} />
    </QueryClientProvider>
  );
}

function ScriptEditor({ request }: { request: ScriptEditorRequest }) {
  const { projectId, script } = request;
  const returnFocus = useRef(request.returnFocus);
  const save = usePluginMutation("saveProjectScript", {
    onSuccess: (result) =>
      queryClient.setQueryData(queryKey("projectScripts", { projectId }), result),
  });
  const close = () => setEditorRequest(null);
  const saveEdit = (edit: ProjectScriptEdit, done: string) =>
    save.mutate(
      { projectId, edit },
      {
        onSuccess: () => {
          close();
          toast.success(done);
        },
        onError: (error) =>
          toast.error("Could not save the script", { description: error.message }),
      },
    );
  return (
    <ScriptDialog
      script={script}
      projectName={request.projectName}
      pending={save.isPending}
      returnFocus={returnFocus}
      onClose={close}
      onDelete={() => {
        if (script) saveEdit({ kind: "delete", scriptId: script.id }, `Deleted ${script.name}`);
      }}
      onSave={(draft: ScriptDraft) =>
        saveEdit(
          { kind: "upsert", script: { id: script?.id ?? crypto.randomUUID(), ...draft } },
          script ? `Saved ${draft.name}` : `Added ${draft.name}`,
        )
      }
    />
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
  checkout,
  threadId,
}: {
  thread: PluginSidebarThread;
  checkout: ThreadEnvironment | null;
  threadId: string;
}) {
  const terminal = useThreadTerminal(threadId);
  const machine = thread.host?.name ?? "No machine";
  return (
    <CardRow
      icon="Laptop"
      label={machine}
      title={checkout?.path ?? machine}
      action={
        checkout ? (
          <RowMenu label="Checkout actions">
            <MenuLabel>{checkout.isWorktree ? "Worktree" : "Checkout"}</MenuLabel>
            {checkout.path ? (
              <MenuItem
                icon="Copy"
                detail={checkout.path}
                onSelect={() => void copy(checkout.path!, "Copied the path")}
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
          </RowMenu>
        ) : undefined
      }
    />
  );
}

function ScriptsRow({
  threadId,
  scripts: state,
  lastRunId,
  menuRef,
  onRun,
  onEdit,
}: {
  threadId: string;
  scripts: ScriptsState;
  lastRunId: string | null;
  menuRef: RefObject<HTMLButtonElement | null>;
  onRun(scriptId: string): void;
  onEdit(script: ProjectScript | null): void;
}) {
  const terminal = useThreadTerminal(threadId);
  if (state.state === "loading") return <CardRow icon="Play" label="Loading scripts…" />;
  if (state.state === "failed") {
    return (
      <CardRow
        icon="Play"
        label={<Muted>Scripts unavailable</Muted>}
        title={state.message}
        trailing="Retry"
        onClick={state.retry}
      />
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
    return <CardRow icon="Plus" label="Add project script" onClick={() => onEdit(null)} />;
  }
  return (
    <CardRow
      icon="Play"
      label={`Run ${preferred.name}`}
      title={preferred.command}
      disabled={terminal.pending}
      onClick={() => run(preferred)}
      action={
        <RowMenu label="Project scripts" triggerRef={menuRef}>
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
        </RowMenu>
      }
    />
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

async function copy(text: string, done: string) {
  const ok = await copyToClipboard({ text }).catch(() => false);
  if (ok) toast.success(done);
  else toast.error("Could not copy to the clipboard.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
