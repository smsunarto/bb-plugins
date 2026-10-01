import { useState } from "react";
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
 * A click reveals the file in the diff. Viewed boxes live on the diff headers,
 * as upstream.
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
  const byPath = new Map(progress?.files.map((file) => [file.path, file]));
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);

      if (!next.delete(path)) next.add(path);

      return next;
    });

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
            onReveal={onReveal}
            onToggleViewed={onToggleViewed}
          />
        );
      const { names, folder } = compress(element);
      const open = !collapsed.has(folder.path);

      return (
        <div
          key={`dir:${folder.path}`}
          role="treeitem"
          aria-expanded={open}
          aria-label={folder.path}
        >
          <button
            type="button"
            className="review-changed-files-row review-changed-files-folder flex h-[22px] w-full min-w-0 cursor-pointer items-center gap-1.5 pr-2 text-left text-[12px] text-[var(--ink-muted)] hover:bg-[var(--wb-surface-raised)]"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggle(folder.path)}
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
      {render(buildChangedTree(files), 0)}
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

function FileRow({
  file,
  name,
  depth,
  progress,
  showFileCounts,
  active,
  onReveal,
  onToggleViewed,
}: {
  file: ReviewDiffFileWire;
  name: string;
  depth: number;
  progress?: ReviewDiffProgressFile;
  showFileCounts: boolean;
  active: boolean;
  onReveal(path: string): void;
  onToggleViewed?: (path: string) => void;
}) {
  const counts = treeCounts(file, progress, showFileCounts);

  return (
    <div className="flex items-center">
      {onToggleViewed && file.status !== "unchanged" ? (
        <input
          type="checkbox"
          className="ml-2 cursor-pointer accent-[var(--wb-accent)]"
          checked={progress?.state === "viewed"}
          aria-label={`${progress?.state === "viewed" ? "Mark unviewed" : "Mark viewed"}: ${file.path}`}
          onChange={() => onToggleViewed(file.path)}
        />
      ) : null}
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        aria-label={file.path}
        title={counts.tooltip}
        data-review-file={file.path}
        className={`review-changed-files-row flex h-[22px] w-full min-w-0 cursor-pointer items-center gap-1.5 pr-2 text-left text-[12px] hover:bg-[var(--wb-surface-raised)] ${active ? "bg-[var(--wb-surface-raised)] text-[var(--ink)]" : "text-[var(--ink-muted)]"} ${progress?.state === "viewed" ? "review-file-viewed opacity-50" : ""} ${progress?.state === "folded" ? "review-file-folded opacity-50" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 + 14 }}
        onClick={() => onReveal(file.path)}
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
