// Adapted from the pr-walkthrough plugin's changed-file-tree: same Pierre Trees
// model and non-scrolling row-fitted height, themed against bb host tokens in
// app.css. Source here is the dotfiles repo's working-tree git status, so paths
// are already sorted by git and the tree keeps that order.
import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";

import { cn } from "@/lib/utils";
import type { ChangedFile } from "../server";

const preserveGitOrder = () => 0;
const TREE_ROW_HEIGHT = 24;
const TREE_BORDER_WIDTH = 1;
const DEFAULT_MAX_TREE_HEIGHT = 320;
// Unlike the pr-walkthrough original, this tree keeps its own virtualized
// scroller: it is capped at maxHeight, so only the visible rows are in the DOM
// no matter how many files changed. Releasing the gutter avoids reserving
// scrollbar space in the common case where every row fits.
const TREE_CSS = `[data-file-tree-virtualized-scroll="true"] { scrollbar-gutter: auto; }`;

type ChangedFileTreeProps = {
  ariaLabel?: string;
  className?: string;
  files: ChangedFile[];
  // Tallest the tree may grow, in px. Past this it scrolls internally.
  maxHeight?: number;
  onSelectedPathChange: (path: string) => void;
  selectedPath?: string;
};

function gitStatus(files: ChangedFile[]): GitStatusEntry[] {
  return files.map((file) => ({ path: file.path, status: file.status }));
}

export function ChangedFileTree({
  ariaLabel = "Changed files",
  className,
  files,
  maxHeight = DEFAULT_MAX_TREE_HEIGHT,
  onSelectedPathChange,
  selectedPath,
}: ChangedFileTreeProps) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const statuses = useMemo(() => gitStatus(files), [files]);
  const pathsRef = useRef(paths);
  const onSelectedPathChangeRef = useRef(onSelectedPathChange);
  pathsRef.current = paths;
  onSelectedPathChangeRef.current = onSelectedPathChange;

  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: statuses,
    initialExpansion: "open",
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: TREE_ROW_HEIGHT,
    onSelectionChange: (selection) => {
      const nextPath = selection.find((path) =>
        pathsRef.current.includes(path),
      );
      if (nextPath) onSelectedPathChangeRef.current(nextPath);
    },
    paths,
    search: false,
    sort: preserveGitOrder,
    stickyFolders: false,
    unsafeCSS: TREE_CSS,
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
  const contentHeight =
    visibleRowCount * model.getItemHeight() + TREE_BORDER_WIDTH * 2;
  const treeHeight = Math.min(contentHeight, maxHeight);

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(statuses);
  }, [model, paths, statuses]);

  useEffect(() => {
    if (
      !selectedPath ||
      !paths.includes(selectedPath) ||
      model.getSelectedPaths().includes(selectedPath)
    )
      return;
    for (const path of model.getSelectedPaths())
      model.getItem(path)?.deselect();
    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath, { focus: true, offset: "nearest" });
  }, [model, paths, selectedPath]);

  return (
    <FileTree
      aria-label={ariaLabel}
      className={cn(
        "diff-file-tree block w-full overflow-hidden rounded-md border border-border",
        className,
      )}
      data-file-tree="changed-files"
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
