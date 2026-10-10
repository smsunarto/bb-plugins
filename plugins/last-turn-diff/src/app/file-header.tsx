import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { Change } from "../shared/contract.ts";

// Pierre draws its change icon and line counts inside a shadow root, where app.css
// cannot reach. `unsafeCSS` is its supported hook: 12px icons match the 12px
// chevron, and Pierre's "-R +A" counts give way to DiffCounts in every row.
const HEADER_CSS =
  "[data-change-icon]{width:12px;height:12px}[data-additions-count],[data-deletions-count]{display:none}";

const CHANGE_TYPES: Record<ChangeTypes, string> = {
  change: "Modified",
  new: "Added",
  deleted: "Deleted",
  "rename-pure": "Renamed",
  "rename-changed": "Renamed",
};

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** Points down; CSS rotates it right while its toggle is collapsed. */
export function Chevron() {
  return (
    <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
    </svg>
  );
}

/** BB's DiffStatsTally notation: "+added -removed", ASCII hyphen, en-US grouping. */
export function DiffCounts({
  added,
  removed,
  hideZero = false,
}: {
  added: number;
  removed: number;
  hideZero?: boolean;
}) {
  const showAdded = !hideZero || added > 0;
  const showRemoved = !hideZero || removed > 0;
  if (!showAdded && !showRemoved) return null;
  return (
    <span className="last-turn-diff-counts">
      {showAdded ? (
        <span className="last-turn-diff-added">+{COUNT_FORMAT.format(added)}</span>
      ) : null}
      {showAdded && showRemoved ? " " : null}
      {showRemoved ? (
        <span className="last-turn-diff-removed">-{COUNT_FORMAT.format(removed)}</span>
      ) : null}
    </span>
  );
}

function stripPrefix(name: string | undefined): string | undefined {
  return name?.replace(/^[ab]\//, "");
}

function parseHeader(patch: string | null, name: string): FileDiffMetadata | null {
  // Headerless provider hunks remain the host's responsibility to normalize.
  if (!patch || patch.trimStart().startsWith("@@")) return null;
  try {
    const parsed = getSingularPatch(patch);
    // Recorded patches without a `diff --git` header keep their `a/` and `b/`
    // prefixes, which Pierre reads as a rename. Only a real rename keeps it.
    const renamed = stripPrefix(parsed.prevName) !== stripPrefix(parsed.name);
    if (renamed) return { ...parsed, name, lang: "text" };
    const { prevName: _prevName, ...rest } = parsed;
    return { ...rest, type: "change", name, lang: "text" };
  } catch {
    return null;
  }
}

export function FileHeader({
  changes,
  open,
  bodyId,
  onToggle,
}: {
  changes: Change[];
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const change = changes[0]!;
  const editCount = changes.length;
  const added = changes.reduce((total, edit) => total + edit.added, 0);
  const removed = changes.reduce((total, edit) => total + edit.removed, 0);
  const { name, mode } = useCodeTheme();
  const displayPath = change.relPath ?? change.path;
  const lastPatch = changes.at(-1)!.patch;
  const fileDiff = useMemo((): FileDiffMetadata | null => {
    const first = parseHeader(change.patch, displayPath);
    if (!first || editCount === 1) return first;
    // Successive edits: the entry's type compares the file before its first
    // edit with the file after its last one. Only a first edit that changes or
    // renames the file describes an entry that existed throughout.
    const existed = first.type !== "new";
    const exists = parseHeader(lastPatch, displayPath)?.type !== "deleted";
    if (existed && exists && first.type !== "deleted") return first;
    const { prevName: _prevName, ...rest } = first;
    return { ...rest, type: existed === exists ? "change" : exists ? "new" : "deleted" };
  }, [change.patch, lastPatch, displayPath, editCount]);
  const file = useMemo(
    () => ({ name: displayPath, contents: "", lang: "text" as const }),
    [displayPath],
  );
  // Headers need no syntax highlighting or worker jobs. Bodies go through BB's DiffHost.
  const options = useMemo(
    () => ({
      collapsed: true,
      stickyHeader: false,
      theme: name,
      themeType: mode,
      unsafeCSS: HEADER_CSS,
    }),
    [mode, name],
  );
  // Pierre's change icon is unlabeled, so screen readers hear the type from here.
  const status =
    fileDiff &&
    `${CHANGE_TYPES[fileDiff.type]}${fileDiff.type.startsWith("rename") ? ` from ${fileDiff.prevName}` : ""}`;
  const renderToggle = () => (
    <>
      <button
        type="button"
        className="last-turn-diff-chevron"
        aria-label={`${open ? "Collapse" : "Expand"} ${displayPath}`}
        aria-describedby={status ? `${bodyId}-status` : undefined}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <Chevron />
      </button>
      {status ? (
        <span id={`${bodyId}-status`} hidden>
          {status}
        </span>
      ) : null}
    </>
  );
  const renderMetadata = () => (
    <span className="last-turn-diff-row-meta">
      {editCount > 1 ? <span className="last-turn-diff-edit-count">{editCount} edits</span> : null}
      <DiffCounts added={added} removed={removed} hideZero />
    </span>
  );
  return fileDiff ? (
    <FileDiff
      className="last-turn-diff-file-header"
      disableWorkerPool
      fileDiff={fileDiff}
      options={options}
      renderHeaderPrefix={renderToggle}
      renderHeaderMetadata={renderMetadata}
    />
  ) : (
    <File
      className="last-turn-diff-file-header"
      disableWorkerPool
      file={file}
      options={options}
      renderHeaderPrefix={renderToggle}
      renderHeaderMetadata={renderMetadata}
    />
  );
}
