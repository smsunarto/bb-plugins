/**
 * Changed-file rows and the diff under an opened one. Ported from
 * `plugins/gitbutler/src/app/file-list.tsx` (rows, change-kind glyphs, the
 * directory-then-name path) and `file-cards.tsx` (the Pierre diff card).
 * Rows open in place, one at a time per list; a diff is parsed only once
 * its row is open.
 */
import {
  experimental_useCodeTheme as useCodeTheme,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useTabVisible as useTabVisible,
} from "@get-bb/plugin-sdk/app";
import { SVGSpriteSheet, getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { memo, useMemo, type ReactNode } from "react";
import {
  describeProblem,
  type FileChange,
  type FilePatch,
  type PatchSource,
} from "../core/change.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";

type ChangeKind = FileChange["kind"];

/*
 * Pierre's change-kind artwork, the same sprite `plugins/monokai` puts on bb's
 * diff headers, so a file reads the same here and in the diff it opens to.
 */
const FILE_LOOK: Readonly<Record<ChangeKind, { label: string; tone: string; symbol: string }>> = {
  added: { label: "Added", tone: "text-success", symbol: "added" },
  modified: { label: "Modified", tone: "text-warning", symbol: "modified" },
  deleted: { label: "Deleted", tone: "text-destructive", symbol: "deleted" },
  renamed: { label: "Renamed", tone: "text-(--pr-merged)", symbol: "moved" },
  copied: { label: "Copied", tone: "text-(--pr-merged)", symbol: "moved" },
};

/** Each symbol's path data, read once from the sprite. */
const SPRITE_PATHS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ...SVGSpriteSheet.matchAll(
      /<symbol id="diffs-icon-symbol-([\w-]+)"[^>]*>([\s\S]*?)<\/symbol>/g,
    ),
  ].map(([, name, body]) => [name!, [...body!.matchAll(/ d="([^"]+)"/g)].map(([, d]) => d!)]),
);

export function FileStatus({ kind }: { kind: ChangeKind }) {
  const look = FILE_LOOK[kind];
  return (
    <>
      <svg
        viewBox="0 0 16 16"
        className={cx("size-3.5 shrink-0", look.tone)}
        fill="currentColor"
        aria-hidden
      >
        {SPRITE_PATHS.get(look.symbol)?.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <span className="sr-only">{look.label}</span>
    </>
  );
}

/** The directory first and dimmed, then the name, as GitButler's `FileName` lays out a path. */
export function FileName({ path }: { path: string }) {
  const separator = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {/*
       * The directory gives way before the filename does. No `direction: rtl`:
       * it reorders leading punctuation, so `.bb/` renders as `bb./`.
       */}
      {separator > 0 ? (
        <span className="me-px min-w-0 shrink truncate text-muted-foreground">
          {path.slice(0, separator)}/
        </span>
      ) : null}
      <span className="max-w-full shrink-0 truncate font-semibold text-foreground">
        {path.slice(separator + 1)}
      </span>
    </span>
  );
}

const ROW =
  "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 ps-3.5 pe-3 text-start text-[12px] leading-4 -outline-offset-2 transition-colors duration-150 hover:bg-surface-raised aria-expanded:bg-surface-raised motion-reduce:transition-none";

/** One file. Memoized on its change object, so opening one row redraws only two. */
const FileRow = memo(function FileRow({
  change,
  open,
  first,
  onToggle,
}: {
  change: FileChange;
  open: boolean;
  first: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      type="button"
      title={change.path}
      aria-expanded={open}
      className={cx(ROW, !first && "border-t border-border-hairline")}
      onClick={() => onToggle(change.path)}
    >
      <FileName path={change.path} />
      <FileStatus kind={change.kind} />
    </button>
  );
});

/**
 * A list of changed files; `diff` is drawn under the open one. `more` counts
 * files the read left out.
 */
export function FileRows({
  changes,
  expanded,
  onToggle,
  diff,
  more = 0,
}: {
  changes: readonly FileChange[];
  expanded: string | null;
  onToggle: (path: string) => void;
  diff: ReactNode;
  more?: number;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="Changed files">
      {changes.map((change, index) => (
        <li key={change.path} className="min-w-0">
          <FileRow
            change={change}
            open={expanded === change.path}
            first={index === 0}
            onToggle={onToggle}
          />
          {expanded === change.path ? diff : null}
        </li>
      ))}
      {more > 0 ? (
        <li className="border-t border-border-hairline ps-3.5 pe-3 py-2 text-[12px] leading-4 text-muted-foreground">
          {more} more {more === 1 ? "file" : "files"} not listed
        </li>
      ) : null}
    </ul>
  );
}

type Parsed = ReturnType<typeof getSingularPatch>;

/**
 * Pierre's worker pool keeps a highlighted diff under its `cacheKey`. The key
 * is the patch text itself, not a hash of it: a hash can collide, and then
 * the same path in another commit would draw the old highlight.
 */
export function parsePatch(patch: string): Parsed | null {
  if (patch === "") return null;
  try {
    return { ...getSingularPatch(patch), cacheKey: `source-control:${patch}` };
  } catch {
    return null;
  }
}

/** A diff too large to show, cut short or left out. */
function tooLarge(partial: boolean): string {
  return partial
    ? "This diff is too large to show in full. Open the file in your editor to read the rest."
    : "This diff is too large to show. Open the file in your editor to read it.";
}

/**
 * One file's diff under its row: Pierre's body without its own header, since
 * the row is the header. Unified, because a thread panel is a column.
 */
export const FileDiffCard = memo(function FileDiffCard({ file }: { file: FilePatch }) {
  const { mode, name } = useCodeTheme();
  const parsed = useMemo(() => parsePatch(file.patch), [file.patch]);
  const options = useMemo(
    () => ({
      collapsed: false,
      disableFileHeader: true,
      diffStyle: "unified" as const,
      stickyHeader: false,
      theme: name,
      themeType: mode,
    }),
    [mode, name],
  );
  if (!parsed) {
    return (
      <p className="m-0 border-t border-border-hairline bg-surface-recessed px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {file.truncated
          ? tooLarge(false)
          : file.kind === "renamed" && file.previousPath
            ? `Renamed from ${file.previousPath}.`
            : "No text to show. The file is binary or its contents did not change."}
      </p>
    );
  }
  return (
    <div className="min-w-0 border-t border-border-hairline [--diffs-font-family:var(--font-mono,ui-monospace,monospace)] [--diffs-font-size:11px] [--diffs-line-height:20px]">
      {file.truncated ? (
        <p className="m-0 border-b border-border-hairline px-3.5 py-1 text-[11px] leading-4 text-warning">
          {tooLarge(true)}
        </p>
      ) : null}
      <FileDiff key={parsed.cacheKey} fileDiff={parsed} options={options} />
    </div>
  );
});

/**
 * The patches of a commit or of the uncommitted work, read only while the tab
 * is visible. A commit's never change; uncommitted ones refresh with the thread.
 */
export function usePatches(threadId: string, source: PatchSource) {
  const visible = useTabVisible();
  return useRpcQuery({
    contract: sourceControlContract,
    method: "patches",
    input: { threadId, source },
    enabled: visible,
  });
}

/** File rows standing in while a list loads, at the rows' own height. */
export function FileRowsSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-8 items-center gap-2 ps-3.5 pe-3">
          <Skeleton className={cx("h-2.5", ["w-3/4", "w-1/2", "w-2/3"][index % 3]!)} />
          <Skeleton className="ms-auto size-3.5" />
        </div>
      ))}
    </div>
  );
}

/** What a patches read that did not succeed says, with a way to read again. */
export function PatchesProblem({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 px-3.5 py-2">
      <span className="min-w-0 grow basis-40 text-[12px] leading-4 text-muted-foreground">
        {text}
      </span>
      <Button variant="ghost" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

const UNCOMMITTED: PatchSource = Object.freeze({ kind: "uncommitted" });

/** One file's diff from the uncommitted work, read when its row opens. */
export function UncommittedDiff({ threadId, path }: { threadId: string; path: string }) {
  const read = usePatches(threadId, UNCOMMITTED);
  const answer = read.data;
  const file = answer?.ok ? answer.value.files.find((entry) => entry.path === path) : undefined;
  if (answer === undefined) {
    if (read.error)
      return <PatchesProblem text={read.error.message} onRetry={() => void read.refetch()} />;
    return <FileRowsSkeleton rows={2} label="Loading the diff…" />;
  }
  if (!answer.ok)
    return (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void read.refetch()} />
    );
  if (!file)
    return (
      <p className="m-0 border-t border-border-hairline px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        This file has no uncommitted change now. It was committed or discarded.
      </p>
    );
  return <FileDiffCard file={file} />;
}
