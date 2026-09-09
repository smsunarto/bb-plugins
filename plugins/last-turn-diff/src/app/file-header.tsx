import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { Change } from "../shared/contract.ts";

export function FileHeader({
  change,
  open,
  bodyId,
  onToggle,
}: {
  change: Change;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  const { name, mode } = useCodeTheme();
  const fileDiff = useMemo(() => {
    // Headerless provider hunks remain the host's responsibility to normalize.
    if (!change.patch || change.patch.trimStart().startsWith("@@")) return null;
    try {
      return { ...getSingularPatch(change.patch), lang: "text" as const };
    } catch {
      return null;
    }
  }, [change.patch]);
  const file = useMemo(
    () => ({ name: change.path, contents: "", lang: "text" as const }),
    [change.path],
  );
  // Headers need no syntax highlighting or worker jobs. Bodies go through BB's DiffHost.
  const options = useMemo(
    () => ({ collapsed: true, stickyHeader: false, theme: name, themeType: mode }),
    [mode, name],
  );
  const renderToggle = () => (
    <button
      type="button"
      className="last-turn-diff-chevron"
      aria-label={`${open ? "Collapse" : "Expand"} ${change.path}`}
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
    >
      <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
        <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
      </svg>
    </button>
  );
  return fileDiff ? (
    <FileDiff
      className="last-turn-diff-file-header"
      disableWorkerPool
      fileDiff={fileDiff}
      options={options}
      renderHeaderPrefix={renderToggle}
    />
  ) : (
    <File
      className="last-turn-diff-file-header"
      disableWorkerPool
      file={file}
      options={options}
      renderHeaderPrefix={renderToggle}
      renderHeaderMetadata={() => (
        <span className="last-turn-diff-recorded-counts">
          <span className="last-turn-diff-removed">-{change.removed}</span>
          <span className="last-turn-diff-added">+{change.added}</span>
        </span>
      )}
    />
  );
}
