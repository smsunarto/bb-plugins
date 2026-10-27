import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import type { FileTreeRowDecoration, GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ChangedFile } from "../shared/schema.ts";

type ExplorerFile = Pick<ChangedFile, "path" | "status"> &
  Partial<Pick<ChangedFile, "additions" | "deletions" | "generated">>;
type Entry = { id: string; file: ExplorerFile };
const NO_THREADS: ReadonlyMap<string, number> = new Map();
const STATUS: Record<Exclude<ChangedFile["status"], "unchanged">, GitStatus> = {
  added: "added",
  copied: "added",
  removed: "deleted",
  modified: "modified",
  changed: "modified",
  renamed: "renamed",
};

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_part, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

/** A comparison can contain both deleted `config` and added `config/settings.json`. */
function explorerData(files: readonly ExplorerFile[]) {
  const directories = new Set(files.flatMap((file) => ancestors(file.path)));
  const reserved = new Set([
    ...files.map((file) => file.path),
    ...[...directories].map((path) => path.slice(0, -1)),
  ]);
  const entries = files.map((file): Entry => {
    let id = file.path;
    if (directories.has(`${id}/`)) {
      const kind = file.status === "removed" ? "deleted file" : "file";
      const label = `${file.path} (${kind})`;
      id = label;
      for (let suffix = 2; reserved.has(id); suffix++) id = `${label} ${suffix}`;
      reserved.add(id);
    }
    return { id, file };
  });
  return {
    entries,
    directories: [...directories],
    byId: new Map(entries.map((entry) => [entry.id, entry.file])),
    idForPath: new Map(entries.map((entry) => [entry.file.path, entry.id])),
  };
}

function gitStatus(entries: readonly Entry[]): GitStatusEntry[] {
  return entries.flatMap(({ id, file }) =>
    file.status === "unchanged" ? [] : [{ path: id, status: STATUS[file.status] }],
  );
}

function decoration(file: ExplorerFile, threads: number): FileTreeRowDecoration | null {
  const parts = [];
  if (file.generated) parts.push({ text: "Generated ", color: "var(--muted-foreground)" });
  if (threads > 0) parts.push({ text: `${threads} comments `, color: "var(--muted-foreground)" });
  if (file.additions !== undefined)
    parts.push({ text: `+${file.additions} `, color: "var(--diff-added)" });
  if (file.deletions !== undefined)
    parts.push({ text: `−${file.deletions}`, color: "var(--diff-removed)" });
  return parts.length
    ? {
        text: parts.map((part) => part.text).join(""),
        parts,
        title: `${file.generated ? "Generated file: " : ""}${file.path}: ${parts.map((part) => part.text).join("")}`,
      }
    : null;
}

/** Pierre owns folder navigation; this adapter maps comparison paths and reading context. */
export function FileExplorer({
  files,
  current,
  onSelect,
  filtering = false,
  reveal = null,
  threadsByPath = NO_THREADS,
}: {
  files: readonly ExplorerFile[];
  current: string | null;
  onSelect: (path: string, line: null) => void;
  filtering?: boolean;
  reveal?: { path: string } | null;
  threadsByPath?: ReadonlyMap<string, number>;
}) {
  const data = useMemo(() => explorerData(files), [files]);
  const latest = useRef({ data, threadsByPath });
  useLayoutEffect(() => {
    latest.current = { data, threadsByPath };
  }, [data, threadsByPath]);
  const { model } = useFileTree({
    paths: data.entries.map((entry) => entry.id),
    gitStatus: gitStatus(data.entries),
    initialExpansion: "closed",
    initialExpandedPaths: data.directories,
    flattenEmptyDirectories: true,
    icons: "standard",
    density: "compact",
    itemHeight: 28,
    unsafeCSS: `
      [data-type="item"]:has([title^="Generated file:"]) { color: var(--muted-foreground); }
      [data-type="item"]:has([title^="Generated file:"]) [data-item-section],
      [data-type="item"]:has([title^="Generated file:"]) [style*="color"] { color: var(--muted-foreground) !important; }
    `,
    search: false,
    stickyFolders: false,
    renderRowDecoration: ({ item }) => {
      const { data: snapshot, threadsByPath: threads } = latest.current;
      const file = snapshot.byId.get(item.path);
      return file ? decoration(file, threads.get(file.path) ?? 0) : null;
    },
  });
  const pathsKey = JSON.stringify(data.entries.map((entry) => entry.id));
  const previous = useRef({ pathsKey, directories: data.directories, filtering });
  const expansion = useRef(new Map<string, boolean>());
  useEffect(() => {
    // Search expansions are temporary. Remember the base tree even when its
    // folders disappear from the filtered result, then restore it on clearing.
    if (!previous.current.filtering) {
      for (const path of previous.current.directories) {
        const item = model.getItem(path);
        if (item && "isExpanded" in item) expansion.current.set(path, item.isExpanded());
      }
    }
    if (previous.current.pathsKey !== pathsKey || previous.current.filtering !== filtering) {
      model.resetPaths(
        data.entries.map((entry) => entry.id),
        {
          initialExpandedPaths: data.directories.filter(
            (path) => filtering || expansion.current.get(path) !== false,
          ),
        },
      );
    }
    previous.current = { pathsKey, directories: data.directories, filtering };
    model.setGitStatus(gitStatus(data.entries));
    // Decorations can change independently of Git status (for example a new
    // comment). The public render method repaints the same mounted model.
    if (model.getFileTreeContainer()) model.render({});
  }, [data, filtering, model, pathsKey, threadsByPath]);

  const currentId = data.idForPath.get(current ?? "") ?? null;
  const filterMode = useRef(filtering);
  const pauseFollowing = useRef(false);
  useEffect(() => {
    // Filtering moves the visible diff without the reader navigating. Resume
    // following after the reader acts, or immediately for an explicit reveal.
    const resume = () => {
      pauseFollowing.current = false;
    };
    const listening = new AbortController();
    for (const type of ["wheel", "pointerdown", "touchstart", "keydown"])
      document.addEventListener(type, resume, { passive: true, signal: listening.signal });
    return () => listening.abort();
  }, []);
  const navigation = useRef<{ id: string | null; reveal: typeof reveal }>({
    id: null,
    reveal: null,
  });
  useEffect(() => {
    if (filterMode.current !== filtering) {
      filterMode.current = filtering;
      pauseFollowing.current = true;
    }
    const requested = reveal !== navigation.current.reveal;
    const moved = currentId !== navigation.current.id || reveal !== navigation.current.reveal;
    navigation.current = { id: currentId, reveal };
    for (const path of model.getSelectedPaths())
      if (path !== currentId) model.getItem(path)?.deselect();
    if (!currentId) return;
    const follow = moved && (!pauseFollowing.current || requested);
    if (follow) {
      for (const path of ancestors(currentId)) {
        const item = model.getItem(path);
        if (item && "expand" in item) item.expand();
      }
    }
    model.getItem(currentId)?.select();
    if (follow) model.scrollToPath(currentId, { focus: false, offset: "nearest" });
  }, [currentId, filtering, model, pathsKey, reveal]);

  // Native tree buttons turn Enter/Space into clicks. Use the activated row,
  // since scroll synchronization can change model focus before React sees it.
  const activate = (event: MouseEvent<HTMLElement>) => {
    const row = event.nativeEvent
      .composedPath()
      .find((node) => node instanceof HTMLElement && node.getAttribute("role") === "treeitem");
    const id = row instanceof HTMLElement ? row.getAttribute("data-item-path") : null;
    const path = id ? data.byId.get(id)?.path : null;
    if (path) onSelect(path, null);
  };
  return (
    <FileTree
      model={model}
      aria-label="Changed file explorer"
      className="cr-file-explorer block min-h-0 w-full flex-1"
      onClick={activate}
    />
  );
}
