import { useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/query";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ReadFileResult } from "../rpc/read-file.ts";
import type { SaveFileResult } from "../rpc/save-file.ts";
import type { TaskId, TaskResult } from "../server/domain.ts";
import { DotfilesEditor } from "./editor.tsx";
import { rpc } from "./rpc.ts";

const quickTasks: readonly (TaskId | "publish")[] = [
  "render",
  "check",
  "apply:dry",
  "sync:pull",
  "publish",
];

interface TaskOutput extends TaskResult {
  readonly id: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DotfilesPanelBody() {
  const queryClient = useQueryClient();
  const overview = rpc.overview.useQuery();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [renderHint, setRenderHint] = useState(false);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [taskOutput, setTaskOutput] = useState<TaskOutput | null>(null);
  const file = rpc.readFile.useQuery(
    { path: selectedPath ?? "" },
    { staleTime: Number.POSITIVE_INFINITY, enabled: selectedPath !== null },
  );
  const saveFile = rpc.saveFile.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });
  const runTaskMutation = rpc.runTask.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });
  const publish = rpc.publish.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });
  const removeSkillMutation = rpc.removeSkill.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });

  function selectFile(path: string): void {
    setSelectedPath(path);
    setRenderHint(false);
  }

  async function reloadFile(): Promise<void> {
    if (selectedPath === null) return;
    setRenderHint(false);
    await queryClient.invalidateQueries({
      queryKey: rpc.readFile.queryKey({ path: selectedPath }),
      exact: true,
    });
  }

  async function save(content: string, expectedSha256: string): Promise<SaveFileResult> {
    if (selectedPath === null || file.data === undefined) {
      throw new Error("no file is selected");
    }
    try {
      const result = await saveFile.mutateAsync({
        path: selectedPath,
        content,
        expectedSha256,
      });
      if (result.outcome === "conflict") {
        toast.error("File changed on disk since you opened it. Reload, then re-apply your edit.");
        return result;
      }
      const nextFile: ReadFileResult = {
        ...file.data,
        content,
        sha256: result.sha256,
      };
      queryClient.setQueryData(rpc.readFile.queryKey({ path: selectedPath }), nextFile);
      setRenderHint(result.renderHint);
      toast.success(`Saved ${selectedPath}`);
      return result;
    } catch (error) {
      toast.error(`Save failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async function runTask(task: TaskId | "publish"): Promise<void> {
    if (runningTask !== null) return;
    if (task === "publish" && !window.confirm("Publish? This rebases onto origin/main and pushes."))
      return;

    setRunningTask(task);
    setTaskOutput(null);
    try {
      const result =
        task === "publish"
          ? await publish.mutateAsync()
          : await runTaskMutation.mutateAsync({ task });
      const outputId = task === "publish" ? "sync" : task;
      setTaskOutput({ id: outputId, ...result });
      if (result.exitCode === 0) {
        toast.success(`${outputId} succeeded`);
        if (task === "render" || task === "publish") setRenderHint(false);
      } else {
        toast.error(`${outputId} exited with code ${result.exitCode}`);
      }
    } catch (error) {
      toast.error(`${task} failed: ${errorMessage(error)}`);
    } finally {
      setRunningTask(null);
    }
  }

  async function removeSkill(name: string, path: string): Promise<void> {
    if (!window.confirm(`Remove skill "${name}" via npx skills? This deletes it for every agent.`))
      return;

    try {
      const result = await removeSkillMutation.mutateAsync({ name });
      if (result.outcome === "not-found") {
        toast.error(`Skill ${name} no longer exists`);
        return;
      }
      setTaskOutput({ id: `remove-skill:${name}`, ...result });
      if (result.exitCode === 0) {
        toast.success(`Removed skill ${name}`);
        if (selectedPath === path) setSelectedPath(null);
      } else {
        toast.error(`Removing ${name} failed (exit ${result.exitCode})`);
      }
    } catch (error) {
      toast.error(`Removing ${name} failed: ${errorMessage(error)}`);
    }
  }

  if (overview.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading dotfiles…
      </div>
    );
  }
  if (overview.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">
          Failed to load dotfiles: {errorMessage(overview.error)}
        </p>
        <Button variant="outline" onClick={() => void overview.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const dirtyCount = overview.data.gitEntries.length;

  return (
    <div className="flex h-full min-h-0 flex-col xl:flex-row">
      <aside className="flex max-h-72 w-full shrink-0 flex-col border-b border-border xl:max-h-none xl:w-72 xl:border-b-0 xl:border-r">
        <div className="border-b border-border p-3">
          <div className="text-sm font-medium text-foreground">
            {overview.data.branch}
            <span className="ml-2 text-xs text-muted-foreground">
              {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {overview.data.repoPath}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {quickTasks.map((task) => {
              const label = task === "publish" ? "sync" : task;
              return (
                <Button
                  key={task}
                  size="sm"
                  variant={task === "publish" ? "destructive" : "outline"}
                  disabled={runningTask !== null || !overview.data.repoExists}
                  onClick={() => void runTask(task)}
                >
                  {runningTask === task ? `${label}…` : label}
                </Button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {overview.data.groups.map((group) => (
            <div key={group.id} className="mb-3">
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </div>
              {group.files.map((item) => (
                <div
                  key={item.path}
                  className={`group/row flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm ${
                    selectedPath === item.path
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50"
                  }`}
                >
                  <button
                    type="button"
                    disabled={!item.exists}
                    onClick={() => selectFile(item.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
                    title={item.note}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {!item.exists && <span className="text-xs text-destructive">missing</span>}
                    {item.dirty && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        aria-label="uncommitted changes"
                      />
                    )}
                  </button>
                  {group.id === "skills" && (
                    <button
                      type="button"
                      aria-label={`Remove skill ${item.title}`}
                      title={`Remove ${item.title} (npx skills remove)`}
                      onClick={() => void removeSkill(item.title, item.path)}
                      className="shrink-0 rounded px-1 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedPath === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a tweakable file to view or edit it.
          </div>
        ) : file.isPending ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Loading {selectedPath}…
          </div>
        ) : file.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-destructive">
              Failed to read {selectedPath}: {errorMessage(file.error)}
            </p>
            <Button variant="outline" onClick={() => void file.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <DotfilesEditor
            key={`${selectedPath}:${file.dataUpdatedAt}`}
            path={selectedPath}
            file={file.data}
            renderHint={renderHint}
            isSaving={saveFile.isPending}
            onReload={() => void reloadFile()}
            onSave={save}
          />
        )}

        {taskOutput && (
          <div className="max-h-72 shrink-0 overflow-auto border-t border-border">
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {taskOutput.id} — exit {taskOutput.exitCode}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setTaskOutput(null)}>
                Dismiss
              </Button>
            </div>
            <pre className="whitespace-pre-wrap px-4 pb-4 font-mono text-xs text-foreground">
              {taskOutput.output || "(no output)"}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}

export function DotfilesPanel(_props: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <DotfilesPanelBody />
    </PluginQueryBoundary>
  );
}
