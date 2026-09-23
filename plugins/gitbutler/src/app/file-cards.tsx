import { useCallback, useId, useMemo, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useCodeTheme as useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { ChangeKind, FilePatch, PatchSource } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Loading, Notice, errorText } from "./notice.tsx";
import { COMMIT_QUERY } from "./query-client.ts";
import { rpc, defined } from "./rpc.ts";

const REFRESH_INTERVAL_MS = 10_000;
const COPIED_FEEDBACK_MS = 1_200;

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

/**
 * bb's diff panel draws its own file header in the light DOM, and this panel
 * renders inside the same secondary-panel shelf. Reproducing that markup, down
 * to the `model` prop `plugins/monokai` reads off the fiber, means monokai's
 * header rules and its injected change icon apply here verbatim. Matching it
 * by eye against Pierre's shadow-root header never converged.
 */
function FileHeader({
  model,
  open,
  added,
  removed,
  hasDiff,
  bodyId,
  onToggle,
}: {
  model: { path: string; label: string; changeKind: ChangeKind };
  open: boolean;
  added: number;
  removed: number;
  hasDiff: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    // Sticky like bb's: monokai paints a sticky diff header with its opaque
    // fallback and a static one with a 6% layer, so this is what picks the same
    // fill. It also keeps the path in view while the diff scrolls.
    <div className="sticky top-0 z-10 rounded-lg bg-background px-3 py-0 text-xs font-medium text-foreground">
      <div className="flex min-h-10 w-full min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            className="inline-flex w-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`${open ? "Collapse" : "Expand"} ${model.path}`}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <Icon
              name="ChevronRight"
              className="size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none"
              aria-hidden
            />
          </button>
          {/* monokai's content script prepends the change icon into this span. */}
          <span className="flex min-w-0 flex-1 items-center gap-1.5 pl-[1ch]">
            {/* bb makes the filename a button that opens the file. This panel
                has nowhere to open it, so it toggles the row instead, which
                also gives the disclosure a target worth aiming at. */}
            <button
              type="button"
              className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left font-mono text-xs font-medium leading-5 text-foreground underline-offset-2 hover:underline"
              title={model.path}
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={onToggle}
            >
              {/* `dir=rtl` keeps the tail of a long path visible, as bb does.
                  The LRM stops a leading dot from being reordered. */}
              <span dir="rtl" className="block w-full truncate">
                {`\u200e${model.path}`}
              </span>
            </button>
            <button
              type="button"
              aria-label={`Copy path for ${model.path}`}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground"
              onClick={async () => {
                await navigator.clipboard.writeText(model.path);
                setCopied(true);
                setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
              }}
            >
              <Icon name={copied ? "Check" : "Copy"} className="size-3" aria-hidden />
            </button>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-xs tabular-nums">
            {hasDiff ? (
              <>
                <span className="text-diff-added">+{added}</span>{" "}
                <span className="text-diff-removed">-{removed}</span>
              </>
            ) : (
              /* Every other row ends in a count pair. A bare change letter in
                 that slot read as a count, so say plainly there is none. */
              <span className="text-muted-foreground">No diff</span>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * One file: bb's own header, always drawn, and Pierre's diff body below it once
 * the row is open.
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
  const counts = useMemo(() => countLines(parsed), [parsed]);
  const model = useMemo(
    () => ({ path: file.path, label: file.path, changeKind: file.kind }),
    [file.kind, file.path],
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

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <FileHeader
        model={model}
        open={open}
        added={counts.added}
        removed={counts.removed}
        hasDiff={parsed !== null}
        bodyId={bodyId}
        onToggle={onToggle}
      />
      <div id={bodyId} hidden={!open}>
        {open ? (
          parsed ? (
            <div className="gb-diff border-t border-border">
              {/* One phrasing for one condition, here and in the branch below. */}
              {file.truncated ? (
                <p className="border-b border-border px-2 py-1 text-[11px] text-warning">
                  This diff is too large to show in full. Open the file in your editor to read the
                  rest.
                </p>
              ) : null}
              <FileDiff disableWorkerPool fileDiff={parsed} options={bodyOptions} />
            </div>
          ) : (
            <p className="border-t border-border px-2.5 py-1.5 text-[11px] leading-normal text-muted-foreground">
              {file.truncated
                ? "This diff is too large to show. Open the file in your editor to read it."
                : "No text to show. The file is binary or its contents did not change."}
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

  const patches = rpc.patches.useQuery(
    defined({ threadId, repositoryKey, source }),
    // A commit's diff is fixed by its id. The worktree's is not, so that one
    // is refreshed on the panel's usual cadence.
    source.kind === "commit" ? COMMIT_QUERY : { staleTime: REFRESH_INTERVAL_MS },
  );

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
    return (
      <Notice
        title="Changes failed to load"
        detail={errorText(patches.error)}
        onRetry={() => void patches.refetch()}
      />
    );
  }
  if (!files || files.length === 0) {
    return (
      <Notice
        title="No file changes"
        detail="This commit records no file contents. Merges and empty commits look like this."
      />
    );
  }

  const allOpen = expanded.size >= files.length;
  return (
    <section
      /*
       * Opts this list into monokai's diff-header treatment. bb gates the same
       * rules on its own diff toolbar, which a plugin panel never has.
       */
      data-monokai-diff-surface
      className="mt-2 flex flex-col gap-1.5"
      aria-label="Changed files"
    >
      <header className="flex items-center gap-2 px-0.5 text-[11px] tabular-nums text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        {/* Added before removed, matching the counts on every row below. */}
        <span className="text-diff-added">+{totals.added}</span>
        <span className="text-diff-removed">-{totals.removed}</span>
        {/*
         * A chevron, not bare text: at the same size and colour as the summary
         * beside it, the label alone did not read as something to press.
         */}
        <Button
          variant="ghost"
          size="sm"
          className="ms-auto h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground"
          onClick={() => setExpanded(allOpen ? new Set() : new Set(files.map((file) => file.path)))}
          aria-expanded={allOpen}
        >
          <Icon
            name={allOpen ? "ChevronUp" : "ChevronDown"}
            className="size-3 shrink-0"
            aria-hidden
          />
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
