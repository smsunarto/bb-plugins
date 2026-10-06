import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { SVGSpriteSheet } from "@pierre/diffs";
import type { ChangeKind, FileChange } from "../shared/schema.ts";
import { cn } from "./lib/utils.ts";

/**
 * A changed-files list that behaves like GitButler desktop's: a list or a
 * folder tree behind one shared toggle, and arrow keys that walk the rows.
 */

export type ListMode = "list" | "tree";

const MODE_STORAGE_KEY = "bb-plugin-gitbutler:file-list-mode";

function readMode(): ListMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/*
 * One preference for every list in the panel, as GitButler has one default.
 * Flipping it on one card flips the others on screen with it.
 */
let currentMode: ListMode | null = null;
const modeListeners = new Set<() => void>();

function setListMode(mode: ListMode): void {
  currentMode = mode;
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // The choice still holds until the panel reloads.
  }
  for (const listener of modeListeners) listener();
}

export function useListMode(): [ListMode, (mode: ListMode) => void] {
  const mode = useSyncExternalStore(
    (listener) => {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    () => (currentMode ??= readMode()),
  );
  return [mode, setListMode];
}

/*
 * Pierre's change-kind artwork, the same sprite `plugins/monokai` puts on bb's
 * diff headers, so a file reads the same here and in the diff it opens to.
 */
const FILE_LOOK: Readonly<Record<ChangeKind, { label: string; tone: string; symbol: string }>> = {
  added: { label: "Added", tone: "text-diff-added", symbol: "added" },
  modified: {
    label: "Modified",
    tone: "text-[var(--diffs-modified-color-override,var(--warning))]",
    symbol: "modified",
  },
  deleted: { label: "Deleted", tone: "text-diff-removed", symbol: "deleted" },
  renamed: { label: "Renamed", tone: "text-pr-merged", symbol: "moved" },
  copied: { label: "Copied", tone: "text-pr-merged", symbol: "moved" },
};

/** Each symbol's path data, read once from the sprite. */
const SPRITE_PATHS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ...SVGSpriteSheet.matchAll(
      /<symbol id="diffs-icon-symbol-([\w-]+)"[^>]*>([\s\S]*?)<\/symbol>/g,
    ),
  ].map(([, name, body]) => [name!, [...body!.matchAll(/ d="([^"]+)"/g)].map(([, d]) => d!)]),
);

/** GitButler's solid count pill. */
export function Count({ children }: { children: number }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-secondary px-1.5 text-2xs font-semibold tabular-nums text-secondary-foreground">
      {children}
    </span>
  );
}

/** GitButler's `LineStats`: whichever of the two counts is not zero. */
export function LineStats({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex shrink-0 gap-0.5 text-[11px] font-semibold tabular-nums">
      {added > 0 ? <span className="text-diff-added">+{added}</span> : null}
      {removed > 0 ? <span className="text-diff-removed">-{removed}</span> : null}
    </span>
  );
}

function FileStatus({ kind }: { kind: ChangeKind }) {
  const look = FILE_LOOK[kind];
  return (
    <>
      <svg
        viewBox="0 0 16 16"
        className={cn("size-3.5 shrink-0", look.tone)}
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

/*
 * The toggle's two glyphs, drawn here: bb's icon set has no list or tree
 * artwork, and an unknown name falls back to a lightning bolt.
 */
const MODE_GLYPH: Readonly<Record<ListMode, string>> = {
  list: "M2 3.5h10M2 7h10M2 10.5h10",
  tree: "M2.5 2.5v6.5a1.5 1.5 0 0 0 1.5 1.5h2M2.5 5.5H6M8 5.5h4M8 10.5h4",
};

/** GitButler's list/tree segment control. */
export function ListModeToggle() {
  const [mode, setMode] = useListMode();
  const option = (value: ListMode, label: string) => (
    <button
      type="button"
      className={cn(
        "inline-flex size-5 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground",
        mode === value && "bg-background text-foreground shadow-xs",
      )}
      aria-label={label}
      aria-pressed={mode === value}
      onClick={() => setMode(value)}
    >
      <svg
        viewBox="0 0 14 14"
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        aria-hidden
      >
        <path d={MODE_GLYPH[value]} />
      </svg>
    </button>
  );
  return (
    <span className="flex shrink-0 gap-px rounded-md bg-secondary p-px">
      {option("list", "List view")}
      {option("tree", "Tree view")}
    </span>
  );
}

type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; change: FileChange };

const collator = new Intl.Collator("en", {
  numeric: true,
  caseFirst: "lower",
  sensitivity: "base",
});

/**
 * GitButler's `changesToFileTree` then `abbreviateFolders`: folders before
 * files, natural name order, and a folder whose only child is a folder drawn
 * as one `parent/child` row.
 */
export function fileTree(changes: readonly FileChange[]): TreeNode[] {
  type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: TreeNode[] };
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const change of changes) {
    const parts = change.path.split("/");
    const name = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.dirs.get(part);
      if (!child) {
        child = {
          name: part,
          path: dir.path ? `${dir.path}/${part}` : part,
          dirs: new Map(),
          files: [],
        };
        dir.dirs.set(part, child);
      }
      dir = child;
    }
    dir.files.push({ kind: "file", name, change });
  }
  const byName = (left: TreeNode, right: TreeNode) => collator.compare(left.name, right.name);
  const build = (dir: Dir): TreeNode[] => [
    ...[...dir.dirs.values()]
      .map((child): TreeNode => {
        let folder = child;
        let name = child.name;
        while (folder.files.length === 0 && folder.dirs.size === 1) {
          folder = folder.dirs.values().next().value!;
          name = `${name}/${folder.name}`;
        }
        return { kind: "dir", name, path: folder.path, children: build(folder) };
      })
      .sort(byName),
    ...dir.files.sort(byName),
  ];
  return build(root);
}

/** Every file path in the order a list in `mode` draws it, folded folders included. */
export function fileOrder(changes: readonly FileChange[], mode: ListMode): string[] {
  if (mode === "list") return changes.map((change) => change.path);
  const walk = (nodes: readonly TreeNode[]): string[] =>
    nodes.flatMap((node) => (node.kind === "file" ? [node.change.path] : walk(node.children)));
  return walk(fileTree(changes));
}

/** One drawn row, in the order the list shows them. */
type Row =
  | { kind: "dir"; name: string; path: string; depth: number; open: boolean }
  | { kind: "file"; name: string; change: FileChange; depth: number };

function rowKey(row: Row): string {
  return row.kind === "dir" ? `dir:${row.path}` : row.change.path;
}

function treeRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, depth = 0): Row[] {
  return nodes.flatMap((node): Row[] => {
    if (node.kind === "file")
      return [{ kind: "file", name: node.name, change: node.change, depth }];
    const open = !collapsed.has(node.path);
    return [
      { kind: "dir", name: node.name, path: node.path, depth, open },
      ...(open ? treeRows(node.children, collapsed, depth + 1) : []),
    ];
  });
}

/** GitButler's `FileIndent`: one faint guide per level, centred under a folder's chevron. */
function Indent({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="flex h-full shrink-0 gap-1.5" aria-hidden>
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          className="relative w-2.5 before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-muted-foreground/25"
        />
      ))}
    </span>
  );
}

/** The directory first and dimmed, then the name, as GitButler's `FileName` lays out a path. */
function FileName({ path, showDirectory }: { path: string; showDirectory: boolean }) {
  const separator = path.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {/*
       * The directory gives way before the filename does. No `direction: rtl`:
       * it reorders leading punctuation, so `.bb/` renders as `bb./`.
       */}
      {showDirectory && separator > 0 ? (
        <span className="me-[3px] min-w-0 shrink truncate text-muted-foreground">
          {path.slice(0, separator)}/
        </span>
      ) : null}
      <span className="max-w-full shrink-0 truncate font-semibold">
        {path.slice(separator + 1)}
      </span>
    </span>
  );
}

// bb's own focus outline, drawn inside the row: the card clips anything
// outside it, and a fill alone would read the same as the selected row.
const ROW =
  "flex h-7.5 w-full min-w-0 cursor-pointer items-center gap-2 ps-3.5 pe-2 text-start -outline-offset-2 hover:bg-state-hover aria-selected:bg-state-active";

/**
 * The rows themselves. A click or Enter on a file calls `onSelect` with it.
 * With `followFocus`, the arrow keys call it too as they move, as they do in
 * GitButler's commit view; without it they only move focus.
 */
export function FileList({
  changes,
  mode,
  active = null,
  followFocus = false,
  onSelect,
}: {
  changes: readonly FileChange[];
  mode: ListMode;
  /** The file the list marks as the current one. */
  active?: string | null;
  followFocus?: boolean;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY);
  const tree = useMemo(() => fileTree(changes), [changes]);
  const rows = useMemo<Row[]>(
    () =>
      mode === "tree"
        ? treeRows(tree, collapsed)
        : changes.map((change) => ({ kind: "file", name: change.path, change, depth: 0 })),
    [changes, collapsed, mode, tree],
  );
  const list = useRef<HTMLDivElement>(null);
  // Held by key, not index, so a refetch that adds or drops a row above it
  // leaves the tab stop on the same row.
  const [focused, setFocused] = useState<string | null>(null);
  const focusedIndex = rows.findIndex((row) => rowKey(row) === focused);
  // One tab stop for the whole list: the row last focused, else the active file.
  const activeIndex = rows.findIndex((row) => row.kind === "file" && row.change.path === active);
  const tabStop = focusedIndex >= 0 ? focusedIndex : Math.max(0, activeIndex);

  const toggleDir = (path: string, open?: boolean) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (open ?? next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const focusRow = (index: number) => {
    setFocused(rows[index] ? rowKey(rows[index]) : null);
    list.current?.querySelectorAll<HTMLElement>("[data-row]")[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Number(
      (event.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row,
    );
    const row = rows[index];
    if (!row) return;
    const move = (to: number) => {
      event.preventDefault();
      const target = rows[to];
      if (!target) return;
      focusRow(to);
      if (followFocus && target.kind === "file") onSelect(target.change.path);
    };
    switch (event.key) {
      case "ArrowDown":
      case "j":
        return move(index + 1);
      case "ArrowUp":
      case "k":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight":
      case "l":
        if (row.kind === "dir") {
          event.preventDefault();
          if (row.open) move(index + 1);
          else toggleDir(row.path, true);
        }
        return;
      case "ArrowLeft":
      case "h": {
        event.preventDefault();
        if (row.kind === "dir" && row.open) return toggleDir(row.path, false);
        // Up to the folder this row sits in.
        for (let parent = index - 1; parent >= 0; parent -= 1) {
          if (rows[parent]!.depth < row.depth) return focusRow(parent);
        }
        return;
      }
    }
  };

  return (
    // The role is a tree or a listbox. The rule cannot read a role picked at render time.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={list}
      role={mode === "tree" ? "tree" : "listbox"}
      aria-label="Changed files"
      className="flex flex-col"
      onKeyDown={onKeyDown}
    >
      {rows.map((row, index) => {
        const common = {
          "data-row": index,
          tabIndex: index === tabStop ? 0 : -1,
          onFocus: () => setFocused(rowKey(row)),
        };
        if (row.kind === "dir") {
          return (
            <button
              key={rowKey(row)}
              type="button"
              role="treeitem"
              aria-expanded={row.open}
              aria-level={row.depth + 1}
              title={row.path}
              className={ROW}
              onClick={() => toggleDir(row.path)}
              {...common}
            >
              <span className="flex h-full shrink-0 items-center gap-1.5 text-muted-foreground">
                <Indent depth={row.depth} />
                <Icon
                  name="ChevronDown"
                  className={cn(
                    "-mx-0.5 size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
                    !row.open && "-rotate-90",
                  )}
                  aria-hidden
                />
                <Icon
                  name={row.open ? "FolderOpen" : "Folder"}
                  className="ms-0.5 size-3.5 shrink-0"
                  aria-hidden
                />
              </span>
              <span className="min-w-0 truncate font-semibold">{row.name}</span>
            </button>
          );
        }
        const path = row.change.path;
        return (
          <button
            key={path}
            type="button"
            role={mode === "tree" ? "treeitem" : "option"}
            aria-selected={path === active}
            aria-level={mode === "tree" ? row.depth + 1 : undefined}
            title={path}
            className={cn(ROW, mode === "list" && index > 0 && "border-t border-border-hairline")}
            onClick={() => onSelect(path)}
            {...common}
          >
            {/* The folder row's cluster, with an empty slot where the chevron
                goes, so a file's icon lines up with its sibling folders'. */}
            <span className="flex h-full shrink-0 items-center gap-1.5 text-muted-foreground">
              <Indent depth={row.depth} />
              {mode === "tree" ? <span className="w-2.5 shrink-0" aria-hidden /> : null}
              <Icon
                name="File"
                className={cn("size-3.5 shrink-0", mode === "tree" && "ms-0.5")}
                aria-hidden
              />
            </span>
            <FileName path={path} showDirectory={mode === "list"} />
            <FileStatus kind={row.change.kind} />
          </button>
        );
      })}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * GitButler's `ChangedFilesPanel`: a bordered card whose header folds it, with
 * the count, the line totals, and the list/tree toggle.
 */
export function ChangedFilesCard({
  title,
  count,
  stats,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  stats?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const empty = count === 0;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="flex h-9 min-w-0 items-center gap-2 pe-2">
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ps-2.5 text-start focus-visible:-outline-offset-2 disabled:cursor-default"
          onClick={onToggle}
          aria-expanded={open && !empty}
          disabled={empty}
        >
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !open && "-rotate-90",
              empty && "invisible",
            )}
            aria-hidden
          />
          <span className="truncate text-sm font-semibold">{title}</span>
          <Count>{count}</Count>
          {stats}
        </button>
        {open && !empty ? <ListModeToggle /> : null}
      </header>
      {open && !empty ? <div className="border-t border-border">{children}</div> : null}
    </section>
  );
}
