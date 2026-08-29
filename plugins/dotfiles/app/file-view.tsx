import { useDeferredValue, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { buildDiff, contentKey } from "./diff.ts";
import { FileDiff } from "./diffs-lib.ts";
import type { RepoPath } from "./route.ts";
import { useTasks, type Tasks } from "./tasks.ts";
import { useFileEditor, type ReadyFileEditor } from "./use-file-editor.ts";
import { WorkingFileEditor } from "./working-file-editor.tsx";

export interface FileViewProps {
  readonly path: RepoPath;
}

export function FileView({ path }: FileViewProps): ReactElement {
  const editor = useFileEditor(path);
  const tasks = useTasks();

  if (editor.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading {path}…
      </div>
    );
  }
  if (editor.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{editor.message}</p>
        <Button variant="outline" onClick={editor.retry}>
          Retry
        </Button>
      </div>
    );
  }
  return <ReadyFileView path={path} editor={editor} tasks={tasks} />;
}

function saveStatusLabel(editor: ReadyFileEditor): string {
  if (editor.conflict) return "Conflict";
  if (editor.saving) return "Saving…";
  if (editor.dirty) return "Unsaved changes";
  return "Saved";
}

function ReadyFileView({
  path,
  editor,
  tasks,
}: {
  readonly path: RepoPath;
  readonly editor: ReadyFileEditor;
  readonly tasks: Tasks;
}): ReactElement {
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const deferredContent = useDeferredValue(editor.content);
  const diff = useMemo(
    () => buildDiff(path, editor.headContent, deferredContent),
    [deferredContent, editor.headContent, path],
  );

  return (
    <div
      role="presentation"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          editor.flush();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-48 flex-1 basis-64">
          <div className="truncate font-mono text-sm text-foreground">{path}</div>
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            <Button
              size="sm"
              variant={diffStyle === "unified" ? "secondary" : "ghost"}
              aria-pressed={diffStyle === "unified"}
              onClick={() => setDiffStyle("unified")}
            >
              Unified
            </Button>
            <Button
              size="sm"
              variant={diffStyle === "split" ? "secondary" : "ghost"}
              aria-pressed={diffStyle === "split"}
              onClick={() => setDiffStyle("split")}
            >
              Split
            </Button>
          </div>
          <Button size="sm" variant="outline" onClick={editor.reload} disabled={editor.saving}>
            Reload
          </Button>
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {saveStatusLabel(editor)}
          </span>
        </div>
      </div>

      {editor.conflict && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-destructive">
          <span className="flex-1">Changed on disk.</span>
          <Button size="sm" variant="outline" onClick={editor.reload}>
            Reload
          </Button>
          <Button size="sm" variant="destructive" onClick={editor.overwrite}>
            Overwrite
          </Button>
        </div>
      )}
      {tasks.renderStale && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-amber-500">
          <span className="flex-1">Rendered files are stale.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={tasks.current?.status === "running"}
            onClick={() => tasks.run("render")}
          >
            Run render
          </Button>
        </div>
      )}
      {editor.saveError !== null && (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">
          Save failed: {editor.saveError}
        </div>
      )}

      <div
        className={
          diffStyle === "split"
            ? "grid min-h-0 flex-1 grid-cols-1 lg:grid-rows-[minmax(16rem,2fr)_minmax(16rem,3fr)]"
            : "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2"
        }
      >
        <section
          className={`flex min-h-64 flex-col border-b border-border lg:min-h-0 ${
            diffStyle === "unified" ? "lg:border-b-0 lg:border-r" : ""
          }`}
        >
          <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Working file
          </div>
          <WorkingFileEditor
            path={path}
            value={editor.content}
            onChange={editor.setContent}
            onSave={editor.flush}
          />
        </section>
        <section className="min-h-64 overflow-auto lg:min-h-0">
          <div className="sticky top-0 z-10 border-b border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Diff from HEAD
          </div>
          {diff ? (
            <FileDiff
              key={`${path}:${contentKey(deferredContent)}:${diffStyle}`}
              fileDiff={diff}
              options={{ disableFileHeader: true, diffStyle, overflow: "wrap" }}
              disableWorkerPool
            />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              The diff preview could not parse this file.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
