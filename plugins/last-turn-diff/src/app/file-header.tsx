import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { Change } from "../shared/contract.ts";

// Pierre draws its 16px change icon inside a shadow root, where app.css cannot
// reach. `unsafeCSS` is its supported hook; 12px matches the 11px header text and
// the 12px chevron beside it.
const HEADER_ICON_CSS = "[data-change-icon]{width:12px;height:12px}";

function stripPrefix(name: string | undefined): string | undefined {
  return name?.replace(/^[ab]\//, "");
}

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
  const displayPath = change.relPath ?? change.path;
  const fileDiff = useMemo(() => {
    // Headerless provider hunks remain the host's responsibility to normalize.
    if (!change.patch || change.patch.trimStart().startsWith("@@")) return null;
    try {
      const parsed = getSingularPatch(change.patch);
      // Recorded patches without a `diff --git` header keep their `a/` and `b/`
      // prefixes, which Pierre reads as a rename. Only a real rename keeps it.
      const renamed = stripPrefix(parsed.prevName) !== stripPrefix(parsed.name);
      if (renamed) return { ...parsed, name: displayPath, lang: "text" as const };
      const { prevName: _prevName, ...rest } = parsed;
      return { ...rest, type: "change" as const, name: displayPath, lang: "text" as const };
    } catch {
      return null;
    }
  }, [change.patch, displayPath]);
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
      unsafeCSS: HEADER_ICON_CSS,
    }),
    [mode, name],
  );
  const renderToggle = () => (
    <button
      type="button"
      className="last-turn-diff-chevron"
      aria-label={`${open ? "Collapse" : "Expand"} ${displayPath}`}
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
