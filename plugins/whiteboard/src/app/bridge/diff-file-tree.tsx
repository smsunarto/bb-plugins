import { useState, type KeyboardEvent } from "react";
import type {
  ReviewDiffFileWire,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
} from "../../shared/vendor/review-protocol/src/index.ts";
import { compactDiffCount } from "../vendor/review/app/src/diff-count.tsx";
import { buildChangedTree, type ChangedTreeElement } from "./two-side.ts";

/**
 * The Diffs view file tree, ported from Desktop `reviewChangedFilesTree.ts`:
 * folders first, single-child folder chains compressed into one row, a status
 * glyph, and per file the remaining `+N −N`, or Viewed, Folded or Unchanged.
 * A click reveals the file in the diff. Keyboard follows the WAI-ARIA tree
 * pattern with one tab stop. Each file row ends in a Viewed box, a bb
 * addition (design §0.1); Space on the row toggles it.
 */
export function DiffFileTree({
  files,
  progress,
  activePath,
  showFileCounts = false,
  onReveal,
  onToggleViewed,
}: {
  files: readonly ReviewDiffFileWire[];
  progress?: Pick<ReviewDiffProgress, "files">;
  activePath?: string;
  /** Fall back to the file's own counts when no progress covers it (the tree inside a commit diff). */
  showFileCounts?: boolean;
  onReveal(path: string): void;
  onToggleViewed?: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string>();
  const byPath = new Map(progress?.files.map((file) => [file.path, file]));
  const tree = buildChangedTree(files);
  const shown = visiblePaths(tree, collapsed);
  // The roving tab stop: the last focused row, else the active file, else the first row.
  const tabStop = [focused, activePath].find((path) => path && shown.includes(path)) ?? shown[0];
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);

      if (!next.delete(path)) next.add(path);

      return next;
    });

  /**
   * Arrows, Home and End move between rows; Right and Left also expand and
   * collapse folders. Enter stays the button's click: reveal a file, toggle a folder.
   */
  const navigate = (
    event: KeyboardEvent<HTMLElement>,
    folder?: { path: string; open: boolean },
  ) => {
    const row = event.currentTarget;
    const rows = [
      ...(row.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
    ];
    const index = rows.indexOf(row);
    const level = (item: HTMLElement) => Number(item.getAttribute("aria-level"));
    let next: HTMLElement | undefined;

    switch (event.key) {
      case "ArrowDown":
        next = rows[index + 1];
        break;
      case "ArrowUp":
        next = rows[index - 1];
        break;
      case "Home":
        next = rows[0];
        break;
      case "End":
        next = rows.at(-1);
        break;
      case "ArrowRight":
        if (folder?.open) next = rows[index + 1];
        else if (folder) toggle(folder.path);
        break;
      case "ArrowLeft":
        if (folder?.open) toggle(folder.path);
        else next = rows.slice(0, index).findLast((item) => level(item) < level(row));
        break;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  };

  const render = (elements: readonly ChangedTreeElement[], depth: number) =>
    elements.map((element) => {
      if (element.kind === "file")
        return (
          <FileRow
            key={element.file.path}
            file={element.file}
            name={element.name}
            depth={depth}
            progress={byPath.get(element.file.path)}
            showFileCounts={showFileCounts}
            active={element.file.path === activePath}
            tabbable={element.file.path === tabStop}
            onFocus={setFocused}
            onKeyDown={navigate}
            onReveal={onReveal}
            onToggleViewed={onToggleViewed}
          />
        );
      const { names, folder } = compress(element);
      const open = !collapsed.has(folder.path);

      return (
        <div key={`dir:${folder.path}`}>
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={open}
            aria-label={folder.path}
            tabIndex={folder.path === tabStop ? 0 : -1}
            className="review-changed-files-row review-changed-files-folder flex h-[24px] w-full min-w-0 cursor-pointer items-center gap-1.5 pr-2 text-left text-[12px] text-[var(--ink-muted)]"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(folder.path)}
            onFocus={() => setFocused(folder.path)}
            onKeyDown={(event) => navigate(event, { path: folder.path, open })}
          >
            <Chevron open={open} />
            <span className="review-changed-files-label truncate">{names.join("/")}</span>
          </button>
          {open ? (
            // The ARIA tree pattern nests a folder's items in a group.
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
            <div role="group">{render(folder.children, depth + 1)}</div>
          ) : null}
        </div>
      );
    });

  return (
    <div
      className="review-changed-files flex h-full min-h-0 flex-col overflow-y-auto py-1"
      role="tree"
      aria-label="Changed files"
    >
      {render(tree, 0)}
    </div>
  );
}

/** Join a folder with its single-folder descendants (`compressionEnabled`). */
function compress(folder: Extract<ChangedTreeElement, { kind: "folder" }>) {
  const names = [folder.name];
  let current = folder;

  while (current.children.length === 1 && current.children[0].kind === "folder") {
    current = current.children[0];
    names.push(current.name);
  }

  return { names, folder: current };
}

/** The paths of the rows on screen, in order: files and compressed folders outside collapsed ones. */
function visiblePaths(
  elements: readonly ChangedTreeElement[],
  collapsed: ReadonlySet<string>,
): string[] {
  return elements.flatMap((element) => {
    if (element.kind === "file") return [element.file.path];
    const { folder } = compress(element);

    return [
      folder.path,
      ...(collapsed.has(folder.path) ? [] : visiblePaths(folder.children, collapsed)),
    ];
  });
}

function FileRow({
  file,
  name,
  depth,
  progress,
  showFileCounts,
  active,
  tabbable,
  onFocus,
  onKeyDown,
  onReveal,
  onToggleViewed,
}: {
  file: ReviewDiffFileWire;
  name: string;
  depth: number;
  progress?: ReviewDiffProgressFile;
  showFileCounts: boolean;
  active: boolean;
  tabbable: boolean;
  onFocus(path: string): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  onReveal(path: string): void;
  onToggleViewed?: (path: string) => void;
}) {
  const counts = treeCounts(file, progress, showFileCounts);
  const viewable = onToggleViewed && file.status !== "unchanged";
  const checked = progress?.state === "partial" ? "mixed" : progress?.state === "viewed";

  return (
    <div
      className={`flex h-[24px] items-center gap-1.5 pr-2 hover:bg-[var(--wb-surface-raised)] ${active ? "bg-[var(--wb-surface-raised)]" : ""}`}
    >
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={active}
        // The box is hidden from assistive tech, so the row carries its state.
        aria-checked={viewable ? checked : undefined}
        aria-label={file.path}
        tabIndex={tabbable ? 0 : -1}
        title={counts.tooltip}
        data-review-file={file.path}
        className={`review-changed-files-row flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12px] ${active ? "text-[var(--ink)]" : "text-[var(--ink-muted)]"} ${progress?.state === "viewed" ? "review-file-viewed opacity-50" : ""} ${progress?.state === "folded" ? "review-file-folded opacity-50" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 + 14 }}
        onClick={() => onReveal(file.path)}
        onFocus={() => onFocus(file.path)}
        onKeyDown={(event) => {
          if (event.key === " " && viewable) {
            event.preventDefault();
            // Toggle once per press, as a native checkbox does.
            if (!event.repeat) onToggleViewed(file.path);
          } else onKeyDown(event);
        }}
      >
        <StatusGlyph status={file.status} />
        <span className="review-changed-files-label min-w-0 flex-1 truncate">{name}</span>
        <span className="review-tree-counts shrink-0 font-[family-name:var(--wb-font-mono)] text-[11px] tabular-nums">
          {counts.label ?? (
            <>
              <span className="review-tree-added text-[var(--change-added)]">{counts.added}</span>{" "}
              <span className="review-tree-removed text-[var(--change-removed)]">
                {counts.removed}
              </span>
            </>
          )}
        </span>
      </button>
      {onToggleViewed ? (
        // The lens rows' box (tokens.css). Space on the row is its keyboard
        // path, so it stays out of the tab order and the accessibility tree.
        // An unchanged file keeps the slot so the counts stay aligned.
        <button
          type="button"
          // tokens.css styles `button.review-viewed-check[aria-checked]`, as on the lens rows.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="checkbox"
          className={`review-viewed-check ${viewable ? "" : "is-empty"}`}
          aria-checked={checked}
          aria-hidden="true"
          tabIndex={-1}
          disabled={!viewable}
          title={progress?.state === "viewed" ? "Mark as unviewed" : "Mark as viewed"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onToggleViewed(file.path)}
        />
      ) : null}
    </div>
  );
}

/** What a tree row shows for a file, and its tooltip (`ChangedFilesTreeRenderer`). */
export function treeCounts(
  file: ReviewDiffFileWire,
  progress: ReviewDiffProgressFile | undefined,
  showFileCounts: boolean,
): { label?: string; added?: string; removed?: string; tooltip?: string } {
  if (file.status === "unchanged")
    return { label: "Unchanged", tooltip: "Referenced context; no changed lines" };

  if (progress?.state === "viewed")
    return { label: "Viewed", tooltip: countsTooltip(progress.remaining, progress.total) };

  if (progress?.state === "folded")
    return {
      label: "Folded",
      tooltip: `Folded by default; counted as done\n+${progress.total.additions} −${progress.total.deletions} total`,
    };
  const remaining =
    progress?.remaining ??
    (showFileCounts ? { additions: file.additions, deletions: file.deletions } : undefined);

  if (!remaining) return { label: "", tooltip: "Waiting for structural coverage" };

  return {
    added: `+${compactDiffCount(remaining.additions)}`,
    removed: `−${compactDiffCount(remaining.deletions)}`,
    tooltip: countsTooltip(remaining, progress?.total ?? remaining),
  };
}

/** `reviewCountsTooltip`: what is left, then the whole. */
export function countsTooltip(
  remaining: { additions: number; deletions: number },
  total: { additions: number; deletions: number },
): string {
  return `+${remaining.additions} −${remaining.deletions} remaining\nof +${total.additions} −${total.deletions} total`;
}

const STATUS_COLOR: Record<ReviewDiffFileWire["status"], string> = {
  added: "var(--change-added)",
  deleted: "var(--change-removed)",
  modified: "var(--change-modified)",
  renamed: "var(--change-added)",
  unchanged: "var(--ink-faint)",
};

/** The codicon diff-added / removed / modified / renamed / file glyphs, drawn small. */
export function StatusGlyph({ status }: { status: ReviewDiffFileWire["status"] }) {
  return (
    <svg
      className={`review-changed-files-icon review-changed-files-icon-${status} shrink-0`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke={STATUS_COLOR[status]}
      strokeWidth="1.2"
      aria-hidden="true"
    >
      {status === "unchanged" ? (
        <path d="M3 1.5h4l2.5 2.5v6.5H3z" />
      ) : (
        <>
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
          {status === "added" ? <path d="M6 3.5v5M3.5 6h5" /> : null}
          {status === "deleted" ? <path d="M3.5 6h5" /> : null}
          {status === "modified" ? (
            <circle cx="6" cy="6" r="1.5" fill={STATUS_COLOR.modified} />
          ) : null}
          {status === "renamed" ? <path d="M3.5 6h5M6.5 4l2 2-2 2" /> : null}
        </>
      )}
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="shrink-0 opacity-70"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      <path d="M3.5 2l3 3-3 3" />
    </svg>
  );
}
