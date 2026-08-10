// Vendored from bb-plugin-pr-walkthrough's changed-file-tree, adapted for the
// stack panel: a read-only Pierre Trees file tree with per-row +/− delta
// decorations (files and aggregated folders), non-scrolling row-fitted
// height, themed against bb host tokens in app.css.
import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  FileTreeRowDecoration,
  FileTreeRowDecorationContext,
  GitStatusEntry,
} from "@pierre/trees";
import { FLATTENED_PREFIX } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

import { cn } from "@/lib/utils";

// Structural subset of the server's diff file shape, so the component does
// not depend on the RPC contract types.
export type TreeDiffFile = {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed" | "untracked";
  additions: number | null;
  deletions: number | null;
};

const TREE_ROW_HEIGHT = 24;
const TREE_BORDER_WIDTH = 1;
// The tree keeps a "git" lane after the decoration lane: a dot on directory
// rows, an A/M/D letter on file rows. The row's own status already comes
// through in its filename color, so the lane only adds a marker beside the
// +/− counts. It cannot be turned off through the model, so hide it here.
const NON_SCROLLING_TREE_CSS = [
  // The scroll container insets its rows by `padding-inline − item-margin-x`
  // on the left and subtracts the reserved scrollbar gutter again on the
  // right. This tree never scrolls, so that gutter is dead space and the two
  // sides disagree. Zero the padding here and let the row's own padding hold
  // the text off the edge: the hover fill then spans the full width, flush
  // and symmetric, and the border on the wrapper clips it.
  `[data-file-tree-virtualized-scroll="true"] { overflow-y: clip; scrollbar-gutter: auto; padding-inline: 0; }`,
  `[data-item-section="git"] { display: none; }`,
  // The decoration lane lays its parts out as flex items, so leading
  // whitespace in the text collapses. A gap is the only thing that separates
  // +N from −M here; it matches the gap the panel's own DeltaChip uses.
  `[data-item-section="decoration"] > span { gap: 6px; }`,
].join("\n");

const ADDED_COLOR = "var(--diffs-addition-color, #3fb950)";
const DELETED_COLOR = "var(--diffs-deletion-color, #f85149)";

type RowStats = {
  fileStats: Map<string, { additions: number | null; deletions: number | null }>;
  // `counted` stays false while every file below the directory has unknown
  // counts (binary only), so the row shows nothing instead of "+0 −0".
  // `files` is how many changed files sit below the directory, which is what
  // identifies a row that merely restates the whole diff.
  dirStats: Map<
    string,
    { additions: number; deletions: number; counted: boolean; files: number }
  >;
  total: number;
};

function computeRowStats(files: TreeDiffFile[]): RowStats {
  const fileStats: RowStats["fileStats"] = new Map();
  const dirStats: RowStats["dirStats"] = new Map();
  for (const file of files) {
    fileStats.set(file.path, {
      additions: file.additions,
      deletions: file.deletions,
    });
    const counted = file.additions !== null || file.deletions !== null;
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      const entry = dirStats.get(dir) ?? {
        additions: 0,
        deletions: 0,
        counted: false,
        files: 0,
      };
      entry.additions += file.additions ?? 0;
      entry.deletions += file.deletions ?? 0;
      entry.counted ||= counted;
      entry.files += 1;
      dirStats.set(dir, entry);
    }
  }
  return { fileStats, dirStats, total: files.length };
}

function deltaDecoration(additions: number, deletions: number): FileTreeRowDecoration {
  // The two counts are separated by the lane flex gap, not by whitespace in
  // the text: each part becomes its own flex item, which drops leading spaces
  // (see the decoration rule in NON_SCROLLING_TREE_CSS).
  return {
    text: `+${additions} −${deletions}`,
    parts: [
      { text: `+${additions}`, color: ADDED_COLOR },
      { text: `−${deletions}`, color: DELETED_COLOR },
    ],
  };
}

function gitStatus(files: TreeDiffFile[]): GitStatusEntry[] {
  return files.map((file) => ({ path: file.path, status: file.status }));
}

type ChangedFileTreeProps = {
  ariaLabel?: string;
  className?: string;
  files: TreeDiffFile[];
};

export function ChangedFileTree({
  ariaLabel = "Changed files",
  className,
  files,
}: ChangedFileTreeProps) {
  // The panel refetches on a timer and on every realtime signal, so `files`
  // is a fresh array even when the diff has not moved. Key the derived state
  // on the diff's *content*: resetting the tree discards the expansion and
  // selection the reader set, so it must only happen on a real change.
  const filesRef = useRef(files);
  filesRef.current = files;
  const signature = useMemo(
    () =>
      files
        .map((f) => `${f.status}\0${f.path}\0${f.additions}\0${f.deletions}`)
        .join("\n"),
    [files],
  );
  const { paths, statuses, stats } = useMemo(
    () => ({
      paths: filesRef.current.map((file) => file.path),
      statuses: gitStatus(filesRef.current),
      stats: computeRowStats(filesRef.current),
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- signature is the content key for filesRef (see above)
    [signature],
  );
  const statsRef = useRef(stats);
  statsRef.current = stats;

  const renderRowDecoration = useCallback(
    (context: FileTreeRowDecorationContext): FileTreeRowDecoration | null => {
      // Directory rows come through with a trailing slash, and flattened
      // rows can carry the tree's internal prefix; both are stripped so the
      // path matches the keys computed from the diff.
      const { item, row } = context;
      const path = (
        item.path.startsWith(FLATTENED_PREFIX)
          ? item.path.slice(FLATTENED_PREFIX.length)
          : item.path
      ).replace(/\/+$/, "");
      if (item.kind === "file") {
        const stat = statsRef.current.fileStats.get(path);
        if (!stat || (stat.additions === null && stat.deletions === null))
          return null;
        return deltaDecoration(stat.additions ?? 0, stat.deletions ?? 0);
      }
      const stat = statsRef.current.dirStats.get(path);
      if (!stat || !stat.counted) return null;
      // An open directory has its own children listed right below, each with
      // its counts. The folder total then only repeats what the reader can
      // already see, so it earns its place only while collapsed.
      if (row.isExpanded) return null;
      // A directory holding every changed file restates the totals the caller
      // already shows beside the tree. Two identical figures, one above the
      // other, read as a doubled number rather than as a subtotal.
      if (stat.files === statsRef.current.total) return null;
      return deltaDecoration(stat.additions, stat.deletions);
    },
    [],
  );

  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: statuses,
    initialExpansion: "open",
    itemHeight: TREE_ROW_HEIGHT,
    paths,
    renderRowDecoration,
    search: false,
    stickyFolders: false,
    unsafeCSS: NON_SCROLLING_TREE_CSS,
  });

  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener),
    [model],
  );
  const getVisibleRowCount = useCallback(() => model.getVisibleCount(), [model]);
  const visibleRowCount = useSyncExternalStore(
    subscribe,
    getVisibleRowCount,
    getVisibleRowCount,
  );
  const treeHeight =
    visibleRowCount * model.getItemHeight() + TREE_BORDER_WIDTH * 2;

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(statuses);
  }, [model, paths, statuses]);

  return (
    <FileTree
      aria-label={ariaLabel}
      className={cn(
        "diff-file-tree block w-full overflow-hidden rounded-md border border-border",
        className,
      )}
      data-file-tree="stack-changed-files"
      model={model}
      style={
        {
          "--trees-density-override": 0.8,
          // 0, so rows span the full width and their own padding holds the
          // text off the edge. Units matter here: React passes custom
          // properties through verbatim, and the tree feeds this one to
          // calc(), where a bare number would invalidate the declaration and
          // silently restore the 16px default.
          "--trees-padding-inline-override": "0px",
          boxSizing: "border-box",
          height: `${treeHeight}px`,
        } as CSSProperties
      }
    />
  );
}
