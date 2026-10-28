import { useMemo, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  UrlLink,
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginBrowserBbSdk,
  PluginMessageDirectiveProps,
  PluginSidebarThread,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import {
  type CommitRef,
  type Landed,
  canStillLand,
  commitKey,
  notLanded,
  parseLandedAttributes,
  sameCommit,
} from "../shared/landed.ts";
import { type Account, type PrRef, prKey, prSubPath, sameRef } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { PANEL_PATH, shortSha } from "./format.ts";
import { errorText } from "./notice.tsx";
import { useRpcQuery } from "./rpc.ts";
import { queryClient } from "./query.ts";

/** bb's own Archive, which the sidebar calls Settle. */
const ARCHIVE_ACTION_KEY = "bb--core/archive";
const ARCHIVE_KEYS = [ARCHIVE_ACTION_KEY];

const PR_ICONS = { merged: "GitMerge", open: "GitPullRequest", closed: "GitPullRequestClosed" };

export function LandedEmbed({ attributes, source, message }: PluginMessageDirectiveProps) {
  const target = parseLandedAttributes(attributes);
  if (!target) return <code>{source}</code>;
  return (
    <QueryClientProvider client={queryClient}>
      <LandedCard target={target} threadId={message.threadId} />
    </QueryClientProvider>
  );
}

function LandedCard({
  target,
  threadId,
}: {
  target: { account: Account; prs: PrRef[]; commits: CommitRef[] };
  threadId: string;
}) {
  const landed = useRpcQuery("landed", target, {
    staleTime: 60_000,
    refetchInterval: (query) => (stillLanding(query.state.data) ? 60_000 : false),
  });
  const data = landed.data;
  const total = target.prs.length + target.commits.length;
  const done = data ? total - notLanded(data).length : 0;
  const issue = landed.isError ? errorText(landed.error) : undefined;
  let status = "Checking";
  if (data && done === total) status = "Landed";
  else if (data) status = `${done} of ${total} landed`;
  else if (issue) status = "Unavailable";
  return (
    <section
      aria-label="Landed work"
      className="not-prose my-3 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background text-xs text-foreground"
    >
      <div className="flex items-start gap-2.5 p-3 pb-1.5">
        <Icon
          name="CircleCheck"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Review</span>
            <span aria-live="polite" className={status === "Landed" ? "text-success" : ""}>
              {status}
            </span>
          </div>
          <h3 className="m-0 mt-1 text-xs font-medium">
            {[counted(target.prs.length, "pull request"), counted(target.commits.length, "commit")]
              .filter(Boolean)
              .join(" · ")}
          </h3>
        </div>
      </div>
      <ul className="m-0 list-none px-3 py-1.5">
        {target.prs.map((ref) => (
          <PrRow
            key={prKey(ref)}
            refValue={ref}
            account={target.account}
            read={data?.prs.find((pr) => sameRef(pr.ref, ref))}
          />
        ))}
        {target.commits.map((ref) => (
          <CommitRow
            key={commitKey(ref)}
            refValue={ref}
            read={data?.commits.find((commit) => sameCommit(commit.ref, ref))}
          />
        ))}
      </ul>
      {issue ? (
        <div role="alert" className="px-3 py-2 text-[11px] text-destructive">
          {issue}{" "}
          <button
            type="button"
            className="cursor-pointer underline"
            onClick={() => void landed.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div className="px-3 pt-1 pb-3">
        <SettleButton threadId={threadId} />
      </div>
    </section>
  );
}

/** `1 commit`, `2 commits`; empty for none. */
function counted(count: number, noun: string): string {
  if (count === 0) return "";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Merged and closed are final: poll only while a later read can differ. */
function stillLanding(data: Landed | undefined): boolean {
  return data === undefined || canStillLand(data);
}

function PrRow({
  refValue,
  account,
  read,
}: {
  refValue: PrRef;
  account: Account;
  read?: Landed["prs"][number];
}) {
  const navigate = useBbNavigate();
  const label = read?.title ?? prKey(refValue);
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 py-1 text-start"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(refValue, "summary", account) })
        }
      >
        <Icon
          name={read ? PR_ICONS[read.state] : "GitPullRequest"}
          className={`size-3 shrink-0 ${read?.state === "merged" ? "text-success" : "text-muted-foreground"}`}
          aria-label={read?.state ?? "pull request"}
        />
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          #{refValue.number}
        </span>
      </button>
    </li>
  );
}

function CommitRow({ refValue, read }: { refValue: CommitRef; read?: Landed["commits"][number] }) {
  const label = read?.headline ?? commitKey(refValue);
  return (
    <li>
      <UrlLink
        href={
          read?.url ??
          `https://github.com/${refValue.owner}/${refValue.repo}/commit/${refValue.sha}`
        }
        className="flex min-w-0 items-center gap-2 py-1 text-foreground no-underline"
      >
        <Icon
          name="GitBranch"
          className={`size-3 shrink-0 ${read?.landed ? "text-success" : "text-muted-foreground"}`}
          aria-label={
            read ? (read.landed ? `on ${read.branch}` : `not on ${read.branch}`) : "commit"
          }
        />
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {shortSha(read?.ref.sha ?? refValue.sha)}
        </span>
      </UrlLink>
    </li>
  );
}

/**
 * Settles the thread with bb's own Archive, so its confirmation for a thread
 * with children, its split-pane cleanup, and its Undo toast all apply. The
 * sidebar's live list answers for an active thread; a thread missing from it
 * is read from bb, so only an archived thread reads as settled.
 */
function SettleButton({ threadId }: { threadId: string }) {
  const sidebar = useSidebarThreads();
  const row = sidebar.threads.find((each) => each.id === threadId);
  const sdk = useSdk();
  const stored = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => sdk.threads.get({ threadId }),
    enabled: row === undefined && sidebar.status === "ready",
    staleTime: 0,
    refetchOnMount: "always",
  });
  const target = useMemo(
    () => (row ? rowTarget(row) : stored.data ? storedTarget(stored.data) : null),
    [row, stored.data],
  );
  if (target && target.archivedAt === null) return <ArchiveButton target={target} />;
  const settled = target !== null;
  return (
    <Button size="sm" variant="outline" className="h-7 w-full gap-1.5 text-xs" disabled>
      {settled ? "Settled" : "Settle thread"}
      {settled ? <Icon name="Check" className="size-3" aria-hidden /> : null}
    </Button>
  );
}

function ArchiveButton({ target }: { target: PluginThreadActionTarget }) {
  const [entry] = useThreadActions(target, { keys: ARCHIVE_KEYS });
  const [running, setRunning] = useState(false);
  return (
    <Button
      size="sm"
      className="h-7 w-full gap-1.5 text-xs"
      disabled={!entry || entry.action.disabled === true || running}
      onClick={() => {
        if (!entry) return;
        setRunning(true);
        // bb shows its own toast when the archive fails.
        void entry.action
          .run()
          .catch(() => {})
          .finally(() => {
            setRunning(false);
            // A thread the sidebar leaves out says it settled only once bb's read does.
            void queryClient.invalidateQueries({ queryKey: ["thread", target.id] });
          });
      }}
    >
      Settle thread
      <Icon name="Check" className="size-3" aria-hidden />
    </Button>
  );
}

type StoredThread = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["get"]>>;

/** The fields bb's thread actions read, from bb's own read of a thread the sidebar leaves out. */
function storedTarget(thread: StoredThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: false,
    status: thread.status,
    environment: thread.environmentId ? { id: thread.environmentId, path: null } : null,
  };
}

/** The fields bb's thread actions read, copied from the sidebar's row. */
function rowTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const environment = thread.environment;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment?.id == null ? null : { id: environment.id, path: environment.path ?? null },
  };
}
