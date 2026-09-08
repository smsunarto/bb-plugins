import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";

export function EmbedHeader({
  path,
  label,
  kind,
  expanded,
  onToggle,
  openWorkspaceFile,
  children,
}: {
  path: string;
  label: string;
  kind: "diff" | "preview";
  expanded: boolean;
  onToggle: () => void;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
  children?: ReactNode;
}) {
  return (
    <figcaption className="smart-embed-header smart-diff-header">
      <button
        type="button"
        className="smart-diff-toggle"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${kind} ${label}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <svg aria-hidden="true" viewBox="0 0 10 16" fill="currentColor">
          <path d="M.47 5.47a.75.75 0 0 1 1.06 0L5 8.94l3.47-3.47a.75.75 0 0 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06" />
        </svg>
      </button>
      {openWorkspaceFile === null ? (
        <span className="smart-diff-path" title={label}>
          <bdi>{label}</bdi>
        </span>
      ) : (
        <button
          type="button"
          className="smart-diff-path smart-diff-open"
          title={label}
          aria-label={`Open ${path} in the workspace`}
          onClick={() => openWorkspaceFile(path)}
        >
          <bdi>{label}</bdi>
        </button>
      )}
      {children}
    </figcaption>
  );
}
