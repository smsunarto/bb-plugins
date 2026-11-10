/**
 * The Files tab's tree: folders with single-child chains flattened, each
 * file with its change-kind glyph and size, the current file selected.
 * Ported from code-review's `file-explorer.tsx` (flattened folders, folders
 * open, follow the current file, generated files muted) without
 * `@pierre/trees`, whose bundle (about 250 KB with preact) would double the
 * page module for one column.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { startsCollapsed, type ChangeFile } from "../../core/review.ts";
import { cx } from "../format.ts";
import { FileStatus } from "../file-cards.tsx";
import { Chevron } from "./icons.tsx";
import { useListWindow } from "./use-window.ts";

/** Every row is `h-7`, so a long tree windows without measuring. */
const ROW_HEIGHT = 28;

type Folder = { kind: "folder"; path: string; name: string; children: Node[] };
type Leaf = { kind: "file"; path: string; name: string; file: ChangeFile };
type Node = Folder | Leaf;

export function buildTree(files: readonly ChangeFile[]): Node[] {
  const root: Folder = { kind: "folder", path: "", name: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    parts.slice(0, -1).forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let next = folder.children.find(
        (child): child is Folder => child.kind === "folder" && child.path === path,
      );
      if (!next) {
        next = { kind: "folder", path, name: part, children: [] };
        folder.children.push(next);
      }
      folder = next;
    });
    folder.children.push({ kind: "file", path: file.path, name: parts.at(-1)!, file });
  }
  // `a/b/c/` with one child folder each reads as one row.
  const flatten = (node: Node): Node => {
    if (node.kind === "file") return node;
    let folder = node;
    while (folder.children.length === 1 && folder.children[0]!.kind === "folder") {
      const only = folder.children[0] as Folder;
      folder = { ...only, name: `${folder.name}/${only.name}` };
    }
    const children = folder.children.map(flatten).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ...folder, children };
  };
  return (flatten(root) as Folder).children;
}

type Row = { node: Node; depth: number };

function visibleRows(nodes: readonly Node[], closed: ReadonlySet<string>, depth = 0): Row[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "folder" && !closed.has(node.path)
      ? visibleRows(node.children, closed, depth + 1)
      : []),
  ]);
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  current,
  open,
  onFile,
  onFolder,
}: {
  node: Node;
  depth: number;
  current: boolean;
  open: boolean;
  onFile: (path: string) => void;
  onFolder: (path: string) => void;
}) {
  const indent = { paddingInlineStart: 8 + depth * 12 };
  if (node.kind === "folder")
    return (
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        title={node.path}
        style={indent}
        onClick={() => onFolder(node.path)}
        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent pe-2 text-start text-[12px] leading-4 text-muted-foreground hover:bg-surface-raised"
      >
        <Chevron
          className={cx(
            "shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
    );
  const { file } = node;
  const generated = startsCollapsed(file.path);
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={current}
      title={generated ? `Generated file: ${file.path}` : file.path}
      style={indent}
      data-testid="sc-tree-file"
      onClick={() => onFile(file.path)}
      className={cx(
        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent pe-2 text-start text-[12px] leading-4 hover:bg-surface-raised aria-selected:bg-border-hairline",
        generated ? "text-muted-foreground" : "text-foreground",
      )}
    >
      <FileStatus kind={file.kind} />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {file.binary ? null : (
        <span className="shrink-0 font-mono text-[11px] text-(--tertiary-foreground) tabular-nums">
          <span className="text-success-foreground">+{file.additions}</span>{" "}
          <span className="text-destructive-text">−{file.deletions}</span>
        </span>
      )}
    </button>
  );
});

export function FileTree({
  files,
  current,
  onSelect,
}: {
  files: readonly ChangeFile[];
  current: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (path: string) =>
      setClosed((previous) => {
        const next = new Set(previous);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );
  // The current file's folders stay open, so following it never hides it.
  const shown = useMemo(() => {
    if (!current) return closed;
    const open = new Set(closed);
    const parts = current.split("/");
    for (let index = 1; index < parts.length; index++) open.delete(parts.slice(0, index).join("/"));
    return open.size === closed.size ? closed : open;
  }, [closed, current]);
  const rows = useMemo(() => visibleRows(tree, shown), [tree, shown]);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const sizeOf = useCallback(() => ROW_HEIGHT, []);
  const keyOf = useCallback(
    (index: number) => `${rows[index]!.node.kind}:${rows[index]!.node.path}`,
    [rows],
  );
  // A 300-file tree is thousands of nodes; past 50 rows only those near the view mount.
  const win = useListWindow({ count: rows.length, sizeOf, keyOf, list });
  const row = ({ node, depth }: Row) => (
    <TreeRow
      key={`${node.kind}:${node.path}`}
      node={node}
      depth={depth}
      current={node.kind === "file" && node.path === current}
      open={node.kind === "folder" && !shown.has(node.path)}
      onFile={onSelect}
      onFolder={toggle}
    />
  );
  return (
    <div ref={setList} role="tree" aria-label="Changed files" className="flex flex-col py-1">
      {win.items ? (
        <div className="relative" style={{ height: win.total }}>
          {win.items.map((virtual) => (
            <div
              key={virtual.key as string}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtual.start - win.margin}px)` }}
            >
              {row(rows[virtual.index]!)}
            </div>
          ))}
        </div>
      ) : (
        rows.map(row)
      )}
    </div>
  );
}
