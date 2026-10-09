import type { OplogEntry } from "../shared/schema.ts";
import { AskAgentButton } from "./ask-agent.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { CopyButton } from "./copy-button.tsx";
import { shortId } from "./format.ts";
import { FileRowsSkeleton, Notice, errorText } from "./notice.tsx";
import { REFRESH_INTERVAL_MS } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { When } from "./when.tsx";

/**
 * `but` 0.22.3 titles most entries with the operation's own name, as in
 * "CreateCommit". Those read as words here. Any other title is kept as written.
 */
function operationTitle(title: string): string {
  if (!/^(?:[A-Z][a-z0-9]+)+$/.test(title)) return title;
  const [first = "", ...rest] = title.split(/(?=[A-Z])/);
  return [first, ...rest.map((word) => word.toLowerCase())].join(" ");
}

/** What the reader asks the agent for a snapshot. The panel never restores one itself. */
function restoreRequest(entry: OplogEntry, title: string): string {
  return `Restore the GitButler workspace to snapshot ${entry.id} (${title}) with \`but oplog restore\`.`;
}

function OperationRow({ entry }: { entry: OplogEntry }) {
  const title = operationTitle(entry.title);
  const short = shortId(entry.id);
  return (
    <li className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={title}>
          {title}
        </span>
        {entry.body ? (
          <span className="truncate text-[11px] text-muted-foreground" title={entry.body}>
            {entry.body}
          </span>
        ) : null}
      </span>
      <When
        value={entry.createdAt}
        className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
      />
      <code className="shrink-0 font-mono text-[11px] text-muted-foreground" translate="no">
        {short}
      </code>
      <CopyButton value={entry.id} label={`Copy snapshot id ${short}`} />
      <AskAgentButton
        text={restoreRequest(entry, title)}
        label={`Ask agent to restore snapshot ${short}`}
      />
    </li>
  );
}

function Operations({ target }: { target: WorkspaceTarget }) {
  // Read again while open, as the board is: the agent can write while the reader looks.
  const oplog = rpc.oplog.useQuery(target, {
    staleTime: REFRESH_INTERVAL_MS,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const data = oplog.data;
  // A poll that fails after a good read keeps the list on screen.
  if (!data) {
    return oplog.isPending ? (
      <FileRowsSkeleton label="Loading operations…" rows={4} />
    ) : (
      <Notice
        icon="AlertTriangle"
        title="History failed to load"
        detail={errorText(oplog.error)}
        onRetry={() => void oplog.refetch()}
      />
    );
  }
  if (data.reason !== null) {
    return (
      <Notice
        icon="AlertTriangle"
        title="History unavailable"
        detail={data.reason}
        onRetry={() => void oplog.refetch()}
      />
    );
  }
  if (data.entries.length === 0) {
    return (
      <Notice
        icon="Clock"
        title="No operations yet"
        detail="GitButler lists each change it makes to this workspace here."
      />
    );
  }
  return (
    <ol className="mt-2.5 list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {data.entries.map((entry) => (
        <OperationRow key={entry.id} entry={entry} />
      ))}
    </ol>
  );
}

/**
 * GitButler's operation log, newest first: a snapshot it took before each
 * write to this workspace. Read only. A restore rewrites the workspace, so
 * each row asks the agent for it instead.
 */
export function OperationHistory({ target }: { target: WorkspaceTarget }) {
  return (
    <>
      <h2 className="m-0 text-sm font-semibold">Operation history</h2>
      <p className="mt-1 leading-normal text-muted-foreground">
        GitButler's recent operations on this workspace, newest first.
      </p>
      <Operations target={target} />
    </>
  );
}
