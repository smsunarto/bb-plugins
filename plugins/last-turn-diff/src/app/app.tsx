import { UnityDiffView } from "@bb-plugins/unity-inspector/app";
import type { UnityDiff } from "@bb-plugins/unity-inspector/model";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import {
  definePluginApp,
  experimental_Diff as Diff,
  useRealtime,
  useRealtimeConnectionState,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CHANGED_CHANNEL, type Change, type LatestTurn } from "../shared/contract.ts";
import { mountDiffPortal } from "./portal.ts";
import { turnChanges } from "../shared/patches.ts";
import { rpc } from "./rpc.ts";
import { FileHeader } from "./file-header.tsx";
import "./app.css";

type WorkspaceGroup = { key: string; label: string; changes: Change[] };

/**
 * Group changes by owning workspace: the thread's own first, foreign
 * workspaces after in the order their changes appeared.
 */
function groupByWorkspace(changes: Change[], ownLabel: string | undefined): WorkspaceGroup[] {
  const own: WorkspaceGroup = { key: "", label: ownLabel ?? "This workspace", changes: [] };
  const foreign = new Map<string, WorkspaceGroup>();
  for (const change of changes) {
    if (change.workspace === undefined) {
      own.changes.push(change);
      continue;
    }
    let group = foreign.get(change.workspace);
    if (!group) {
      group = { key: change.workspace, label: change.workspace, changes: [] };
      foreign.set(change.workspace, group);
    }
    group.changes.push(change);
  }
  return [own, ...foreign.values()].filter((group) => group.changes.length > 0);
}

function TurnDiff({ turn }: { turn: LatestTurn }) {
  const bodyIdPrefix = useId();
  const changes = useMemo(() => turnChanges(turn), [turn]);
  const groups = useMemo(
    () => groupByWorkspace(changes, turn.workspace),
    [changes, turn.workspace],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const hasExpanded = changes.some((change) => expanded.has(change.id));
  if (changes.length === 0 && !turn.limited) return null;
  const fileCount = new Set(changes.map((change) => change.path)).size;
  const added = changes.reduce((total, change) => total + change.added, 0);
  const removed = changes.reduce((total, change) => total + change.removed, 0);
  return (
    <section
      className="last-turn-diff"
      aria-label="Last turn changes"
      data-last-turn-id={turn.turnId}
    >
      <header className="last-turn-diff-heading">
        <strong>Last turn</strong>
        <span>
          {fileCount} {fileCount === 1 ? "file" : "files"} changed
        </span>
        <span className="last-turn-diff-added">+{added}</span>
        <span className="last-turn-diff-removed">−{removed}</span>
        {changes.length > 0 ? (
          <button
            type="button"
            className="last-turn-diff-toggle-all"
            onClick={() =>
              setExpanded(hasExpanded ? new Set() : new Set(changes.map((change) => change.id)))
            }
          >
            {hasExpanded ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </header>
      {turn.limited ? (
        <p className="last-turn-diff-notice">Some changes exceed the preview limit.</p>
      ) : null}
      {groups.map((group) => (
        <section className="last-turn-diff-workspace" key={group.key || "own"}>
          {groups.length > 1 ? (
            <h3 className="last-turn-diff-workspace-label" title={group.label}>
              {group.label}
            </h3>
          ) : null}
          {group.changes.map((change) => (
            <div className="last-turn-diff-file" key={change.id}>
              <FileHeader
                change={change}
                open={expanded.has(change.id)}
                bodyId={`${bodyIdPrefix}-${change.id}`}
                onToggle={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(change.id)) next.delete(change.id);
                    else next.add(change.id);
                    return next;
                  });
                }}
              />
              <div id={`${bodyIdPrefix}-${change.id}`} hidden={!expanded.has(change.id)}>
                <FileBody
                  unity={turn.unity?.[change.id]}
                  patch={change.patch}
                  path={change.relPath ?? change.path}
                  open={expanded.has(change.id)}
                  showLineNumbers={!change.unpositioned}
                />
              </div>
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}

function FileBody({
  patch,
  path,
  open,
  unity,
  showLineNumbers,
}: {
  patch: string | null;
  path: string;
  open: boolean;
  unity?: UnityDiff;
  showLineNumbers: boolean;
}) {
  if (!open) return <div className="last-turn-diff-body" />;
  const raw = patch ? (
    <Diff
      patch={patch}
      path={path}
      view="unified"
      overflow="scroll"
      showLineNumbers={showLineNumbers}
    />
  ) : (
    <p className="last-turn-diff-notice">No text diff recorded for this change.</p>
  );
  return (
    <div className="last-turn-diff-body">
      {unity ? <UnityDiffView diff={unity} path={path} raw={raw} /> : raw}
    </div>
  );
}

function LatestDiff({ threadId }: { threadId: string }) {
  const owner = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const query = rpc.latestTurn.useQuery(
    { threadId },
    {
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      gcTime: 0,
    },
  );
  const { refetch } = query;
  const connection = useRealtimeConnectionState();
  useRealtime(CHANGED_CHANNEL, (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "threadId" in payload &&
      payload.threadId === threadId
    )
      void refetch();
  });
  useEffect(() => {
    if (connection === "connected") void refetch();
  }, [connection, refetch]);
  const turn = query.isError ? null : query.data?.turn;
  const anchorId = turn?.anchorId;
  useEffect(() => {
    if (!anchorId) return;
    const scope = owner.current?.closest("[data-split-pane-id]") ?? document;
    return mountDiffPortal(scope, anchorId, setTarget);
  }, [anchorId, threadId]);
  return (
    <>
      <span
        ref={owner}
        hidden
        data-last-turn-diff-owner=""
        data-last-turn-diff-current={turn?.turnId}
      />
      {target && anchorId && turn
        ? createPortal(<TurnDiff key={turn.turnId} turn={turn} />, target)
        : null}
    </>
  );
}

function ThreadDiff(props: PluginThreadHeaderActionProps) {
  return (
    <PluginQueryBoundary>
      <LatestDiff key={props.threadId} threadId={props.threadId} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "latest-diff",
    title: "Last turn diff",
    component: ThreadDiff,
  });
});
