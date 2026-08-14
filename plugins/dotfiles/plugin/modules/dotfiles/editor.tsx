import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  FileDiff,
  parseDiffFromFile,
  processFile,
  type FileContents,
  type FileDiffMetadata,
} from "../../../diffs-lib.js";
import type { ReadFileResult, SaveFileResult } from "./contract.js";

const languageOverrides: Readonly<Record<string, string>> = {
  ".gitconfig": "ini",
};

function languageFor(path: string): string | undefined {
  return languageOverrides[path.split("/").at(-1) ?? ""];
}

function contentKey(content: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${content.length}:${hash >>> 0}`;
}

export function buildDiff(
  path: string,
  headContent: string | null,
  workingContent: string,
): FileDiffMetadata | null {
  const language = languageFor(path);
  const workingKey = contentKey(workingContent);
  const newFile: FileContents = {
    name: path,
    contents: workingContent,
    cacheKey: `${path}:working:${workingKey}`,
    ...(language ? { lang: language } : {}),
  };
  if (headContent === null) return parseDiffFromFile(null, newFile);

  const oldFile: FileContents = {
    name: path,
    contents: headContent,
    cacheKey: `${path}:head:${contentKey(headContent)}`,
    ...(language ? { lang: language } : {}),
  };
  if (headContent !== workingContent) {
    return parseDiffFromFile(oldFile, newFile, { context: 1_000_000_000 });
  }

  let lines = workingContent.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines = lines.slice(0, -1);
  const count = lines.length;
  const patch =
    `--- ${path}\n+++ ${path}\n@@ -1,${count} +1,${count} @@\n`
    + `${lines.map((line) => ` ${line}`).join("\n")}\n`;
  const metadata = processFile(patch, {
    cacheKey: `${path}:unchanged:${workingKey}`,
    oldFile,
    newFile,
  }) ?? null;
  if (metadata && language) metadata.lang = language;
  return metadata;
}

export interface DotfilesEditorProps {
  readonly path: string;
  readonly file: ReadFileResult;
  readonly renderHint: boolean;
  readonly isSaving: boolean;
  readonly onReload: () => void;
  readonly onSave: (
    content: string,
    expectedSha256: string,
  ) => Promise<SaveFileResult>;
}

export function DotfilesEditor({
  path,
  file,
  renderHint,
  isSaving,
  onReload,
  onSave,
}: DotfilesEditorProps) {
  const [content, setContent] = useState(file.content);
  const [savedContent, setSavedContent] = useState(file.content);
  const [sha256, setSha256] = useState(file.sha256);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const deferredContent = useDeferredValue(content);
  const diff = useMemo(
    () => buildDiff(path, file.headContent, deferredContent),
    [deferredContent, file.headContent, path],
  );
  const isEdited = content !== savedContent;

  async function save(): Promise<void> {
    const result = await onSave(content, sha256);
    if (result.outcome === "written") {
      setSavedContent(content);
      setSha256(result.sha256);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-48 flex-1 basis-64">
          <div className="truncate font-mono text-sm text-foreground">{path}</div>
          {renderHint && (
            <div className="text-xs text-amber-500">
              Host-owned rendered files are stale. Run render.
            </div>
          )}
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
          <Button size="sm" variant="outline" onClick={onReload} disabled={isSaving}>
            Reload
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!isEdited || isSaving}>
            {isSaving ? "Saving…" : isEdited ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <div
        className={diffStyle === "split"
          ? "grid min-h-0 flex-1 grid-cols-1 lg:grid-rows-[minmax(16rem,2fr)_minmax(16rem,3fr)]"
          : "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2"}
      >
        <section
          className={`flex min-h-64 flex-col border-b border-border lg:min-h-0 ${
            diffStyle === "unified" ? "lg:border-b-0 lg:border-r" : ""
          }`}
        >
          <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Working file
          </div>
          <textarea
            aria-label={`Edit ${path}`}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
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
