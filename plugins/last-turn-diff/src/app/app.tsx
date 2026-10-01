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
import { Chevron, FileHeader } from "./file-header.tsx";
import "./app.css";

/** `other` marks changes other agents made in this checkout, whatever the workspace label. */
type WorkspaceGroup = { key: string; label: string; other: boolean; changes: Change[] };

/**
 * Group changes by owning workspace: the thread's own first, foreign
 * workspaces after in the order their changes appeared, and changes other
 * agents made in this checkout during the turn last.
 */
function groupByWorkspace(changes: Change[], ownLabel: string | undefined): WorkspaceGroup[] {
  const own: WorkspaceGroup = {
    key: "own",
    label: ownLabel ?? "This workspace",
    other: false,
    changes: [],
  };
  const others: WorkspaceGroup = {
    key: "other",
    label: "Other agents in this checkout",
    other: true,
    changes: [],
  };
  const foreign = new Map<string, WorkspaceGroup>();
  for (const change of changes) {
    if (change.other) {
      others.changes.push(change);
      continue;
    }
    if (change.workspace === undefined) {
      own.changes.push(change);
      continue;
    }
    let group = foreign.get(change.workspace);
    if (!group) {
      group = {
        key: `workspace:${change.workspace}`,
        label: change.workspace,
        other: false,
        changes: [],
      };
      foreign.set(change.workspace, group);
    }
    group.changes.push(change);
  }
  return [own, ...foreign.values(), others].filter((group) => group.changes.length > 0);
}

function TurnDiff({ turn }: { turn: LatestTurn }) {
  const bodyIdPrefix = useId();
  const changes = useMemo(() => turnChanges(turn), [turn]);
  const groups = useMemo(
    () => groupByWorkspace(changes, turn.workspace),
    [changes, turn.workspace],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Others' changes are context, not this turn's work, so they start collapsed.
  const [othersOpen, setOthersOpen] = useState(false);
  const visible = othersOpen ? changes : changes.filter((change) => !change.other);
  const hasExpanded = visible.some((change) => expanded.has(change.id));
  if (changes.length === 0 && !turn.limited) return null;
  // Totals describe this turn; other agents' changes are listed but not counted.
  const own = changes.filter((change) => !change.other);
  const fileCount = new Set(own.map((change) => change.path)).size;
  const added = own.reduce((total, change) => total + change.added, 0);
  const removed = own.reduce((total, change) => total + change.removed, 0);
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
        {visible.length > 0 ? (
          <button
            type="button"
            className="last-turn-diff-toggle-all"
            onClick={() =>
              // Only visible files change, so a collapsed group keeps its own state.
              setExpanded((current) => {
                const next = new Set(current);
                for (const { id } of visible) {
                  if (hasExpanded) next.delete(id);
                  else next.add(id);
                }
                return next;
              })
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
        <section className="last-turn-diff-workspace" key={group.key}>
          {/* Others' changes are always labeled so they never read as this turn's. */}
          {group.other ? (
            <h3 className="last-turn-diff-workspace-label" title={group.label}>
              <button
                type="button"
                className="last-turn-diff-group-toggle"
                aria-expanded={othersOpen}
                aria-controls={`${bodyIdPrefix}-other`}
                onClick={() => setOthersOpen((open) => !open)}
              >
                <Chevron />
                {group.label}
                <span className="last-turn-diff-group-count">
                  {group.changes.length} {group.changes.length === 1 ? "file" : "files"}
                </span>
              </button>
            </h3>
          ) : groups.length > 1 ? (
            <h3 className="last-turn-diff-workspace-label" title={group.label}>
              {group.label}
            </h3>
          ) : null}
          <div id={group.other ? `${bodyIdPrefix}-other` : undefined}>
            {group.other && !othersOpen
              ? null
              : group.changes.map((change) => (
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
          </div>
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
