/**
 * The Projects tab's instruction and skill file tree: folders with single-child chains
 * flattened, folders open, the routed file selected and revealed. A local React tree in place
 * of `@pierre/trees`, whose bundle (about 225 KB with Preact) dwarfed this one column.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Icon } from "../../components/ui/icon.tsx";
import { cn } from "../../lib/utils.ts";

/** Folder paths end in `/`, so a folder never shares an identity with a file. */
type Folder = { kind: "folder"; path: string; name: string; children: TreeNode[] };
type Leaf = { kind: "file"; path: string; name: string };
export type TreeNode = Folder | Leaf;

type Row = { node: TreeNode; depth: number; parent: string | null };

const EMPTY: ReadonlySet<string> = new Set();

/** Folder paths (with trailing `/`) that contain `path`, outermost first. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

function byKindThenName(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Builds the folder tree for `paths`, flattening `a/b/c/` chains with one child folder each. */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: Folder = { kind: "folder", path: "", name: "", children: [] };
  const folders = new Map<string, Folder>([["", root]]);
  for (const path of paths) {
    const parts = path.split("/");
    let folder = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const folderPath = `${parts.slice(0, index + 1).join("/")}/`;
      let next = folders.get(folderPath);
      if (!next) {
        next = { kind: "folder", path: folderPath, name: parts[index]!, children: [] };
        folders.set(folderPath, next);
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: "file", path, name: parts.at(-1)! });
  }
  const flatten = (node: TreeNode): TreeNode => {
    if (node.kind === "file") return node;
    let folder = node;
    while (folder.children.length === 1 && folder.children[0]?.kind === "folder") {
      const only = folder.children[0];
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    return { ...folder, children: folder.children.map(flatten).sort(byKindThenName) };
  };
  return root.children.map(flatten).sort(byKindThenName);
}

function visibleRows(
  nodes: readonly TreeNode[],
  closed: ReadonlySet<string>,
  depth = 0,
  parent: string | null = null,
  out: Row[] = [],
): Row[] {
  for (const node of nodes) {
    out.push({ node, depth, parent });
    if (node.kind === "folder" && !closed.has(node.path))
      visibleRows(node.children, closed, depth + 1, node.path, out);
  }
  return out;
}

function toggled(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(path)) next.add(path);
  return next;
}

/** `set` without `path`'s folders, or `set` itself when none of them were closed. */
function withAncestorsOpen(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const folders = ancestors(path).filter((folder) => set.has(folder));
  if (folders.length === 0) return set;
  const next = new Set(set);
  for (const folder of folders) next.delete(folder);
  return next;
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  open,
  selected,
  focusable,
  onActivate,
}: {
  node: TreeNode;
  depth: number;
  open: boolean;
  selected: boolean;
  focusable: boolean;
  onActivate: (node: TreeNode) => void;
}) {
  const folder = node.kind === "folder";
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={folder ? open : undefined}
      aria-selected={selected}
      data-item-path={node.path}
      title={node.path}
      tabIndex={focusable ? 0 : -1}
      style={{ paddingInlineStart: 8 + depth * 12 }}
      onClick={() => onActivate(node)}
      className={cn(
        "flex h-7 w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent pe-2 text-start text-[12px] leading-4 text-foreground outline-none [contain-intrinsic-size:auto_28px] [content-visibility:auto] hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset aria-selected:bg-accent aria-selected:text-accent-foreground max-md:pointer-coarse:h-11",
        folder && "text-muted-foreground",
      )}
    >
      {folder ? (
        <Icon
          name="ChevronRight"
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      ) : (
        <span aria-hidden className="size-3 shrink-0" />
      )}
      <Icon
        name={folder ? "Folder" : "FileText"}
        fallback={folder ? undefined : "Folder"}
        aria-hidden
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
    </button>
  );
});

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
  const tree = useMemo(() => buildTree(paths), [paths]);
  const listed = useMemo(() => new Set(paths), [paths]);
  const pathsKey = useMemo(() => JSON.stringify(paths), [paths]);

  // The reader's folders. Search opens every matching folder temporarily, with its own toggles
  // that reset when the results change; clearing the search restores the reader's tree.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY);
  const [search, setSearch] = useState<{ key: string; closed: ReadonlySet<string> }>({
    key: "",
    closed: EMPTY,
  });
  const searchClosed = search.key === pathsKey ? search.closed : EMPTY;
  const closed = filtering ? searchClosed : collapsed;

  // Browsing selects a folder or file locally; the next route change or reveal selects its file instead.
  const [browse, setBrowse] = useState({ route: selectedPath, path: selectedPath });

  // A route change reveals its file once it is listed, even when it was created after the change.
  // Filtering alone keeps the reader's scroll and folders.
  const [reveal, setReveal] = useState({ route: selectedPath, pending: true, seq: 0 });
  const pending = reveal.route === selectedPath ? reveal.pending : true;
  if (pending && listed.has(selectedPath)) {
    setReveal({ route: selectedPath, pending: false, seq: reveal.seq + 1 });
    setBrowse({ route: selectedPath, path: selectedPath });
    // A file opened from search remains revealed when the base tree is restored.
    setCollapsed((previous) => withAncestorsOpen(previous, selectedPath));
    if (filtering)
      setSearch((previous) =>
        previous.key === pathsKey
          ? { key: pathsKey, closed: withAncestorsOpen(previous.closed, selectedPath) }
          : previous,
      );
  } else if (reveal.route !== selectedPath) {
    setReveal({ route: selectedPath, pending: true, seq: reveal.seq });
  }

  const selection = browse.route === selectedPath ? browse.path : selectedPath;

  const rows = useMemo(() => visibleRows(tree, closed), [tree, closed]);
  const [focused, setFocused] = useState<string | null>(null);
  const focusTarget = useMemo(() => {
    const visible = (path: string | null) =>
      path !== null && rows.some((r) => r.node.path === path);
    if (visible(focused)) return focused;
    if (visible(selection)) return selection;
    return rows[0]?.node.path ?? null;
  }, [focused, rows, selection]);

  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => {
    onOpenRef.current = onOpen;
  });

  const toggleFolder = useCallback(
    (path: string) => {
      if (filtering)
        setSearch((previous) => ({
          key: pathsKey,
          closed: toggled(previous.key === pathsKey ? previous.closed : EMPTY, path),
        }));
      else setCollapsed((previous) => toggled(previous, path));
    },
    [filtering, pathsKey],
  );

  const activate = useCallback(
    (node: TreeNode) => {
      setBrowse({ route: selectedPath, path: node.path });
      setFocused(node.path);
      if (node.kind === "folder") toggleFolder(node.path);
      else onOpenRef.current(node.path);
    },
    [selectedPath, toggleFolder],
  );

  const list = useRef<HTMLDivElement>(null);
  const findRow = (path: string) => {
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(path)
        : path.replace(/([\\"])/g, "\\$1");
    return list.current?.querySelector<HTMLElement>(`[data-item-path="${escaped}"]`) ?? null;
  };
  const focusRow = (path: string) => {
    setFocused(path);
    findRow(path)?.focus({ preventScroll: false });
  };

  useEffect(() => {
    if (reveal.seq === 0) return;
    findRow(reveal.route)?.scrollIntoView?.({ block: "nearest" });
  }, [reveal.route, reveal.seq]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = rows.findIndex((row) => row.node.path === focusTarget);
    const row = rows[index];
    if (!row) return;
    let next: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = rows[index + 1]?.node.path;
        break;
      case "ArrowUp":
        next = rows[index - 1]?.node.path;
        break;
      case "Home":
        next = rows[0]?.node.path;
        break;
      case "End":
        next = rows.at(-1)?.node.path;
        break;
      case "ArrowRight":
        if (row.node.kind !== "folder") return;
        if (closed.has(row.node.path)) toggleFolder(row.node.path);
        else
          next = rows[index + 1]?.parent === row.node.path ? rows[index + 1]!.node.path : undefined;
        break;
      case "ArrowLeft":
        if (row.node.kind === "folder" && !closed.has(row.node.path)) toggleFolder(row.node.path);
        else next = row.parent ?? undefined;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) focusRow(next);
  }

  return (
    <div
      ref={list}
      role="tree"
      tabIndex={-1}
      aria-label="Instruction and skill file tree"
      className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto py-0.5"
      onKeyDown={onKeyDown}
    >
      {rows.map(({ node, depth }) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={depth}
          open={node.kind === "folder" && !closed.has(node.path)}
          selected={node.path === selection}
          focusable={node.path === focusTarget}
          onActivate={activate}
        />
      ))}
    </div>
  );
}
