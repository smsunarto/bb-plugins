import { useCallback, useId, useMemo, useState } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import type { FilePatch, PatchSource } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { changeSymbol } from "./format.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import { rpc, defined } from "./rpc.ts";

const REFRESH_INTERVAL_MS = 10_000;

/*
 * Pierre renders inside a shadow root, so the plugin stylesheet cannot reach
 * its header. `unsafeCSS` is the supported hook, and 12px matches the 11px
 * header text and the chevron beside it.
 */
const HEADER_CSS = "[data-change-icon]{width:12px;height:12px}";

type Parsed = ReturnType<typeof getSingularPatch>;

function parse(patch: string): Parsed | null {
  if (patch === "") return null;
  try {
    return getSingularPatch(patch);
  } catch {
    return null;
  }
}

function countLines(parsed: Parsed | null): { added: number; removed: number } {
  if (!parsed) return { added: 0, removed: 0 };
  return {
    added: parsed.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
    removed: parsed.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
  };
}

function Chevron({
  open,
  label,
  bodyId,
  onToggle,
}: {
  open: boolean;
  label: string;
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="gb-chevron"
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
    >
      <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
        <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
      </svg>
    </button>
  );
}

/**
 * One file: a Pierre header that is always drawn, and the diff body below it
 * once the row is open. Header and body are separate instances so the header's
 * hit target can cover the whole row without swallowing clicks in the code.
 */
function FileCard({
  file,
  open,
  bodyId,
  onToggle,
}: {
  file: FilePatch;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const { mode, name } = useCodeTheme();
  const parsed = useMemo(() => parse(file.patch), [file.patch]);

  const headerOptions = useMemo(
    () => ({
      collapsed: true,
      stickyHeader: false,
      theme: name,
      themeType: mode,
      unsafeCSS: HEADER_CSS,
    }),
    [mode, name],
  );
  const bodyOptions = useMemo(
    () => ({
      collapsed: false,
      disableFileHeader: true,
      // A thread panel is a column, not a page. Split view halves an already
      // narrow column, so the panel always reads unified.
      diffStyle: "unified" as const,
      stickyHeader: false,
      theme: name,
      themeType: mode,
    }),
    [mode, name],
  );
  const placeholder = useMemo(
    () => ({ name: file.path, contents: "", lang: "text" as const }),
    [file.path],
  );

  const toggle = () => (
    <Chevron open={open} label={file.path} bodyId={bodyId} onToggle={onToggle} />
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {parsed ? (
        <FileDiff
          className="gb-file-head"
          disableWorkerPool
          fileDiff={parsed}
          options={headerOptions}
          renderHeaderPrefix={toggle}
        />
      ) : (
        <File
          className="gb-file-head"
          disableWorkerPool
          file={placeholder}
          options={headerOptions}
          renderHeaderPrefix={toggle}
          renderHeaderMetadata={() => (
            <span className="text-[11px] text-muted-foreground">{changeSymbol(file.kind)}</span>
          )}
        />
      )}
      <div id={bodyId} hidden={!open}>
        {open ? (
          parsed ? (
            <div className="gb-diff border-t border-border">
              {file.truncated ? (
                <p className="border-b border-border px-2 py-1 text-[11px] text-warning">
                  Diff truncated to keep the panel responsive.
                </p>
              ) : null}
              <FileDiff disableWorkerPool fileDiff={parsed} options={bodyOptions} />
            </div>
          ) : (
            <p className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {file.truncated
                ? "This diff is past the panel's size budget."
                : "No text diff: this file is binary, empty, or unchanged."}
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every file of a commit or of the worktree, as collapsible diff cards. One
 * `but diff` call covers the whole set, so expanding a row costs nothing.
 */
export function FileCards({
  threadId,
  repositoryKey,
  source,
  initialPath,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  source: PatchSource;
  initialPath: string | null;
}) {
  const bodyIdPrefix = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(initialPath ? [initialPath] : []),
  );

  const patches = rpc.patches.useQuery(defined({ threadId, repositoryKey, source }), {
    staleTime: REFRESH_INTERVAL_MS,
  });

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  // Keyed off the query result, not a fresh `?? []`, so the reduce runs once
  // per fetch rather than once per expand.
  const files = patches.data?.files;
  const totals = useMemo(
    () =>
      (files ?? []).reduce(
        (total, file) => {
          const { added, removed } = countLines(parse(file.patch));
          return { added: total.added + added, removed: total.removed + removed };
        },
        { added: 0, removed: 0 },
      ),
    [files],
  );

  if (patches.isPending) return <Loading label="Loading changes…" />;
  if (patches.isError) {
    return <Notice title="Changes failed to load" detail={errorText(patches.error)} />;
  }
  if (!files || files.length === 0) return <Notice title="No file changes" />;

  const allOpen = expanded.size >= files.length;
  return (
    <section className="mt-2 flex flex-col gap-1.5" aria-label="Changed files">
      <header className="flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="tabular-nums text-diff-added">+{totals.added}</span>
        <span className="tabular-nums text-diff-removed">−{totals.removed}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[11px] font-normal text-muted-foreground"
          onClick={() => setExpanded(allOpen ? new Set() : new Set(files.map((file) => file.path)))}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
      </header>
      {files.map((file) => (
        <FileCard
          key={file.path}
          file={file}
          open={expanded.has(file.path)}
          bodyId={`${bodyIdPrefix}-${file.path}`}
          onToggle={() => toggle(file.path)}
        />
      ))}
    </section>
  );
}
