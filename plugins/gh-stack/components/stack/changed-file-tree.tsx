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
const NON_SCROLLING_TREE_CSS = `[data-file-tree-virtualized-scroll="true"] { overflow-y: clip; scrollbar-gutter: auto; }`;

const ADDED_COLOR = "var(--diffs-addition-color, #3fb950)";
const DELETED_COLOR = "var(--diffs-deletion-color, #f85149)";

type RowStats = {
  fileStats: Map<string, { additions: number | null; deletions: number | null }>;
  // `counted` stays false while every file below the directory has unknown
  // counts (binary only), so the row shows nothing instead of "+0 −0".
  dirStats: Map<string, { additions: number; deletions: number; counted: boolean }>;
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
      };
      entry.additions += file.additions ?? 0;
      entry.deletions += file.deletions ?? 0;
      entry.counted ||= counted;
      dirStats.set(dir, entry);
    }
  }
  return { fileStats, dirStats };
}

function deltaDecoration(additions: number, deletions: number): FileTreeRowDecoration {
  return {
    text: `+${additions} −${deletions}`,
    parts: [
      { text: `+${additions}`, color: ADDED_COLOR },
      { text: ` −${deletions}`, color: DELETED_COLOR },
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
      const { item } = context;
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
          "--trees-padding-inline-override": 8,
          boxSizing: "border-box",
          height: `${treeHeight}px`,
        } as CSSProperties
      }
    />
  );
}
