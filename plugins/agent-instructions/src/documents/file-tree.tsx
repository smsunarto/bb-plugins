import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";

function ancestors(path: string) {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

const theme: CSSProperties & Record<`--trees-${string}`, string> = {
  "--trees-bg-override": "var(--background)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-border-color-override": "transparent",
  "--trees-indent-guide-bg-override": "var(--border)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
};

export function DocumentTree({
  paths,
  selectedPath,
  filtering,
  onOpen,
}: {
  paths: string[];
  selectedPath: string;
  filtering: boolean;
  onOpen: (path: string) => void;
}) {
  const directories = useMemo(() => [...new Set(paths.flatMap(ancestors))], [paths]);
  const { model } = useFileTree({
    paths,
    initialExpansion: "closed",
    initialExpandedPaths: directories,
    flattenEmptyDirectories: true,
    icons: "standard",
    density: "compact",
    itemHeight: 28,
    search: false,
    stickyFolders: false,
  });
  const pathsKey = JSON.stringify(paths);
  const previous = useRef({ pathsKey, directories, filtering });
  const expansion = useRef(new Map<string, boolean>());
  useEffect(() => {
    // Search opens matching folders temporarily; clearing it restores the reader's tree.
    if (!previous.current.filtering) {
      for (const path of previous.current.directories) {
        const item = model.getItem(path);
        if (item && "isExpanded" in item) expansion.current.set(path, item.isExpanded());
      }
    }
    if (previous.current.pathsKey !== pathsKey || previous.current.filtering !== filtering) {
      model.resetPaths(paths, { initialExpandedPaths: directories });
      if (!filtering) {
        for (const path of directories) {
          const item = model.getItem(path);
          if (expansion.current.get(path) === false && item && "collapse" in item) item.collapse();
        }
      }
    }
    previous.current = { pathsKey, directories, filtering };
  }, [directories, filtering, model, paths, pathsKey]);

  const reveal = useRef({ path: "", pending: false });
  useEffect(() => {
    for (const path of model.getSelectedPaths())
      if (path !== selectedPath) model.getItem(path)?.deselect();
    if (reveal.current.path !== selectedPath)
      reveal.current = { path: selectedPath, pending: true };
    if (!paths.includes(selectedPath)) return;
    // A route change reveals its file. Filtering alone keeps the reader's scroll and folders.
    if (reveal.current.pending) {
      for (const path of ancestors(selectedPath)) {
        const item = model.getItem(path);
        // A file opened from search remains revealed when the base tree is restored.
        expansion.current.delete(path);
        if (item && "expand" in item) item.expand();
      }
      model.scrollToPath(selectedPath, { focus: false, offset: "nearest" });
      reveal.current.pending = false;
    }
    model.getItem(selectedPath)?.select();
  }, [model, paths, selectedPath]);

  // Trees' native buttons emit clicks for Enter/Space as well as pointer activation.
  function activate(event: MouseEvent<HTMLElement>) {
    const row = event.nativeEvent
      .composedPath()
      .find((node) => node instanceof HTMLElement && node.getAttribute("role") === "treeitem");
    const path = row instanceof HTMLElement ? row.getAttribute("data-item-path") : null;
    if (path && paths.includes(path)) onOpen(path);
  }
  return (
    <FileTree
      model={model}
      aria-label="Instruction and skill file tree"
      className="block min-h-0 w-full flex-1"
      style={theme}
      onClick={activate}
    />
  );
}
