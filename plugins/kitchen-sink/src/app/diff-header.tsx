import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";

import { EmbedHeader } from "./embed-header.tsx";
import { countPatchChanges } from "./diff-stats.ts";

export function DiffHeader({
  path,
  label,
  proposed,
  truncated,
  patch,
  expanded,
  onToggle,
  openWorkspaceFile,
}: {
  path: string;
  label: string;
  proposed: boolean;
  truncated: boolean;
  patch: string | null;
  expanded: boolean;
  onToggle: () => void;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
}) {
  const stats = useMemo(() => (patch === null ? null : countPatchChanges(patch)), [patch]);
  return (
    <EmbedHeader
      path={path}
      label={label}
      kind="diff"
      expanded={expanded}
      onToggle={onToggle}
      openWorkspaceFile={openWorkspaceFile}
    >
      {proposed ? <span className="smart-diff-proposed">Proposed</span> : null}
      {truncated ? <span className="smart-embed-warning">Truncated</span> : null}
      {stats !== null ? (
        <dl
          className="smart-diff-stats"
          aria-label={`${stats.deletions} removed, ${stats.additions} added`}
          title="Changed lines in this displayed diff"
        >
          <div>
            <dt className="smart-diff-count-label">Removed</dt>
            <dd className="smart-diff-deletions">-{stats.deletions}</dd>
          </div>
          <div>
            <dt className="smart-diff-count-label">Added</dt>
            <dd className="smart-diff-additions">+{stats.additions}</dd>
          </div>
        </dl>
      ) : null}
    </EmbedHeader>
  );
}
