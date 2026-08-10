"use client"

import type { CSSProperties } from "react"
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { GitStatusEntry } from "@pierre/trees"
import { FileTree, useFileTree } from "@pierre/trees/react"

import { cn } from "@/lib/utils"
import type { WalkthroughDiffFile } from "@/data/walkthrough"

import { REVIEW_SURFACE_CLASS } from "./review-surface"

const preserveWalkthroughOrder = () => 0
const TREE_ROW_HEIGHT = 24
const TREE_BORDER_WIDTH = 1
const NON_SCROLLING_TREE_CSS = `[data-file-tree-virtualized-scroll="true"] { overflow-y: clip; scrollbar-gutter: auto; }`

function escapeCssAttributeValue(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")
    .replaceAll("\f", "\\c ")
}

function treeCss(files: WalkthroughDiffFile[]) {
  const generatedRowContentSelectors = files
    .filter((file) => file.generated || file.binary)
    .flatMap((file) => {
      const row = `[data-item-path="${escapeCssAttributeValue(file.path)}"]`
      return [`${row} > [data-item-section="icon"]`, `${row} > [data-item-section="content"]`]
    })

  if (generatedRowContentSelectors.length === 0) return NON_SCROLLING_TREE_CSS

  return `${NON_SCROLLING_TREE_CSS}
${generatedRowContentSelectors.join(",\n")} { opacity: 0.5; }`
}

type ChangedFileTreeProps = {
  ariaLabel?: string
  className?: string
  files: WalkthroughDiffFile[]
  onSelectedPathChange: (path: string) => void
  search?: boolean
  selectedPath?: string
}

function gitStatus(files: WalkthroughDiffFile[]): GitStatusEntry[] {
  return files.map((file) => ({
    path: file.path,
    status: file.status === "copied" ? "added" : file.status,
  }))
}

export function ChangedFileTree({
  ariaLabel = "Changed files",
  className,
  files,
  onSelectedPathChange,
  search = false,
  selectedPath,
}: ChangedFileTreeProps) {
  const paths = useMemo(() => files.map((file) => file.path), [files])
  const statuses = useMemo(() => gitStatus(files), [files])
  const unsafeCSS = useMemo(() => treeCss(files), [files])
  const pathsRef = useRef(paths)
  const onSelectedPathChangeRef = useRef(onSelectedPathChange)
  pathsRef.current = paths
  onSelectedPathChangeRef.current = onSelectedPathChange

  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: statuses,
    initialExpansion: "open",
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: TREE_ROW_HEIGHT,
    onSelectionChange: (selection) => {
      const nextPath = selection.find((path) => pathsRef.current.includes(path))
      if (nextPath) onSelectedPathChangeRef.current(nextPath)
    },
    paths,
    search,
    sort: preserveWalkthroughOrder,
    stickyFolders: false,
    unsafeCSS,
  })

  const subscribe = useCallback((listener: () => void) => model.subscribe(listener), [model])
  const getVisibleRowCount = useCallback(() => model.getVisibleCount(), [model])
  const visibleRowCount = useSyncExternalStore(subscribe, getVisibleRowCount, getVisibleRowCount)
  const treeContentHeight = visibleRowCount * model.getItemHeight()
  const treeHeight = treeContentHeight + TREE_BORDER_WIDTH * 2

  useEffect(() => {
    model.resetPaths(paths)
    model.setGitStatus(statuses)
  }, [model, paths, statuses])

  useEffect(() => {
    if (!selectedPath || !paths.includes(selectedPath) || model.getSelectedPaths().includes(selectedPath)) return
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
    model.getItem(selectedPath)?.select()
    model.scrollToPath(selectedPath, { focus: true, offset: "nearest" })
  }, [model, paths, selectedPath])

  return (
    <FileTree
      aria-label={ariaLabel}
      className={cn("diff-file-tree block w-full", REVIEW_SURFACE_CLASS, className)}
      data-file-tree="changed-files"
      data-review-file-tree
      model={model}
      style={{
        "--trees-density-override": 0.8,
        "--trees-padding-inline-override": 8,
        boxSizing: "border-box",
        height: `${treeHeight}px`,
      } as CSSProperties}
    />
  )
}
