import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
  EditProvider,
  FileDiff,
  Editor,
  type EditorOptions,
} from "./diffs-lib";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";

interface OverviewShape {
  repoPath: string;
  branch: string;
  groups: {
    id: string;
    title: string;
    files: {
      path: string;
      title: string;
      note?: string;
      render?: boolean;
      exists: boolean;
      dirty: boolean;
    }[];
  }[];
  gitEntries: { status: string; path: string }[];
  tasks: { id: string; summary: string }[];
}

const QUICK_TASKS = ["render", "check", "apply:dry", "sync:pull", "sync"];

// Extension-less dotfiles that the library's filename inference maps to plain
// text. git-config has no bundled grammar; ini is the closest match.
const LANG_OVERRIDES: Record<string, string> = {
  ".gitconfig": "ini",
};

function langFor(path: string): string | undefined {
  return LANG_OVERRIDES[path.split("/").pop() ?? ""];
}

// One editable diff surface, like the diffs.com landing demo: the old side is
// HEAD, the new side is the working file, every line renders (full context),
// and typing produces hunks live. Identical sides would make
// parseDiffFromFile throw, so synthesize an all-context patch for that case.
function buildDiff(
  path: string,
  headContent: string | null,
  workingContent: string,
  cacheKey: string,
): FileDiffMetadata | null {
  const lang = langFor(path);
  const newFile: FileContents = { name: path, contents: workingContent, cacheKey, lang };
  if (headContent === null) {
    return parseDiffFromFile(null, newFile);
  }
  const oldFile: FileContents = {
    name: path,
    contents: headContent,
    cacheKey: `${cacheKey}:head`,
    lang,
  };
  if (headContent !== workingContent) {
    return parseDiffFromFile(oldFile, newFile, { context: 1_000_000_000 });
  }
  // No a/ b/ prefixes: without isGitDiff they survive into the file name and
  // the parser reads "a/x -> b/x" as a rename.
  let lines = workingContent.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
  const count = lines.length;
  const patch =
    `--- ${path}\n+++ ${path}\n@@ -1,${count} +1,${count} @@\n` +
    lines.map((line) => ` ${line}`).join("\n") +
    "\n";
  const metadata = processFile(patch, { cacheKey, oldFile, newFile }) ?? null;
  // processFile does not propagate FileContents.lang (parseDiffFromFile does);
  // the renderer reads metadata.lang ?? inference-from-name.
  if (metadata && lang) metadata.lang = lang;
  return metadata;
}

function DotfilesPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<OverviewShape | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [headContent, setHeadContent] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const [renderHint, setRenderHint] = useState(false);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  const [taskOutput, setTaskOutput] = useState<{
    id: string;
    exitCode: number;
    output: string;
  } | null>(null);

  // Editor onChange callbacks are creation-time; route through a ref so they
  // always land in current state.
  const applyEdit = useRef((text: string) => {
    setContent(text);
  });
  // Latest working text, so a diff-style toggle can rebuild the document
  // without losing unsaved edits.
  const contentRef = useRef("");
  contentRef.current = content;

  const refresh = useCallback(async () => {
    try {
      setOverview((await rpc.call("overview")) as OverviewShape);
    } catch (error) {
      toast.error(`Failed to load dotfiles overview: ${String(error)}`);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = useCallback(
    async (path: string) => {
      try {
        const file = await rpc.call("readFile", { path });
        setSelected(path);
        setContent(file.content);
        setSavedContent(file.content);
        setHeadContent(file.headContent);
        setSha(file.sha256);
        setRenderHint(false);
        setLoadNonce((nonce) => nonce + 1);
      } catch (error) {
        toast.error(`Failed to read ${path}: ${String(error)}`);
      }
    },
    [rpc],
  );

  const save = useCallback(async () => {
    if (!selected || sha === null) return;
    try {
      const result = await rpc.call("saveFile", {
        path: selected,
        content,
        expectedSha256: sha,
      });
      if (result.outcome === "conflict") {
        toast.error("File changed on disk since you opened it. Reload, then re-apply your edit.");
        return;
      }
      setSha(result.sha256);
      setSavedContent(content);
      setRenderHint(result.renderHint);
      toast.success(`Saved ${selected}`);
      void refresh();
    } catch (error) {
      toast.error(`Save failed: ${String(error)}`);
    }
  }, [rpc, selected, sha, content, refresh]);

  const runTask = useCallback(
    async (task: string) => {
      if (runningTask) return;
      if (task === "sync" && !window.confirm("Publish? This rebases onto origin/main and pushes.")) {
        return;
      }
      setRunningTask(task);
      setTaskOutput(null);
      try {
        const result = await rpc.call("runTask", { task });
        setTaskOutput({ id: task, ...result });
        if (result.exitCode === 0) {
          toast.success(`${task} succeeded`);
          if (task === "render" || task === "sync") {
            setRenderHint(false);
          }
        } else {
          toast.error(`${task} exited with code ${result.exitCode}`);
        }
        void refresh();
      } catch (error) {
        toast.error(`${task} failed: ${String(error)}`);
      } finally {
        setRunningTask(null);
      }
    },
    [rpc, runningTask, refresh],
  );

  const removeSkill = useCallback(
    async (name: string, path: string) => {
      if (!window.confirm(`Remove skill "${name}" via npx skills? This deletes it for every agent.`)) {
        return;
      }
      try {
        const result = await rpc.call("removeSkill", { name });
        setTaskOutput({ id: `remove-skill:${name}`, ...result });
        if (result.exitCode === 0) {
          toast.success(`Removed skill ${name}`);
          if (selected === path) setSelected(null);
        } else {
          toast.error(`Removing ${name} failed (exit ${result.exitCode}) — see output`);
        }
        void refresh();
      } catch (error) {
        toast.error(`Removing ${name} failed: ${String(error)}`);
      }
    },
    [rpc, selected, refresh],
  );

  // Rebuilt per load and per style toggle, never per keystroke — the edit
  // session owns the document after mount. A toggle rebuilds from the latest
  // working text so unsaved edits survive the remount.
  const diffMetadata = useMemo(() => {
    if (!selected) return null;
    try {
      return buildDiff(
        selected,
        headContent,
        contentRef.current,
        `${selected}:${loadNonce}:${diffStyle}`,
      );
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, loadNonce, diffStyle]);

  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      onChange: (file: FileContents) => applyEdit.current(file.contents),
    }),
    [],
  );

  const diffOptions = useMemo(() => ({ disableFileHeader: true, diffStyle }), [diffStyle]);

  const isEdited = content !== savedContent;
  const dirtyCount = overview?.gitEntries.length ?? 0;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="border-b border-border p-3">
          <div className="text-sm font-medium text-foreground">
            {overview?.branch ?? "…"}
            <span className="ml-2 text-xs text-muted-foreground">
              {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {overview?.repoPath ?? ""}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {QUICK_TASKS.map((task) => (
              <Button
                key={task}
                size="sm"
                variant={task === "sync" ? "destructive" : "outline"}
                disabled={runningTask !== null}
                onClick={() => void runTask(task)}
              >
                {runningTask === task ? `${task}…` : task}
              </Button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {overview?.groups.map((group) => (
            <div key={group.id} className="mb-3">
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.title}
              </div>
              {group.files.map((file) => (
                <div
                  key={file.path}
                  className={`group/row flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm ${
                    selected === file.path
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent/50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void openFile(file.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate">{file.title}</span>
                    {!file.exists && <span className="text-xs text-destructive">missing</span>}
                    {file.dirty && (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                        aria-label="uncommitted changes"
                      />
                    )}
                  </button>
                  {group.id === "skills" && (
                    <button
                      type="button"
                      aria-label={`Remove skill ${file.title}`}
                      title={`Remove ${file.title} (npx skills remove)`}
                      onClick={() => void removeSkill(file.title, file.path)}
                      className="hidden shrink-0 rounded px-1 text-muted-foreground hover:text-destructive group-hover/row:block"
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

      <main className="flex min-w-0 flex-1 flex-col">
        {selected && diffMetadata ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm text-foreground">{selected}</div>
                {renderHint && (
                  <div className="text-xs text-amber-500">
                    Host-owned rendered files are stale — run render.
                  </div>
                )}
              </div>
              <div className="flex rounded-md border border-border p-0.5">
                <Button
                  size="sm"
                  variant={diffStyle === "unified" ? "secondary" : "ghost"}
                  onClick={() => setDiffStyle("unified")}
                >
                  Unified
                </Button>
                <Button
                  size="sm"
                  variant={diffStyle === "split" ? "secondary" : "ghost"}
                  onClick={() => setDiffStyle("split")}
                >
                  Split
                </Button>
              </div>
              {renderHint && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={runningTask !== null}
                  onClick={() => void runTask("render")}
                >
                  Run render
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openFile(selected)}
                disabled={runningTask !== null}
              >
                Reload
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={!isEdited}>
                {isEdited ? "Save" : "Saved"}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <EditProvider
                createEditor={(options: EditorOptions<undefined>) => new Editor(options)}
              >
                <FileDiff
                  key={`diff:${selected}:${loadNonce}:${diffStyle}`}
                  fileDiff={diffMetadata}
                  edit
                  editorOptions={editorOptions}
                  options={diffOptions}
                  disableWorkerPool
                />
              </EditProvider>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a tweakable file to view or edit it.
          </div>
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

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dotfiles",
    title: "Dotfiles",
    icon: "Settings",
    path: "dotfiles",
    component: DotfilesPanel,
  });
});
