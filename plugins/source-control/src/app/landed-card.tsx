/**
 * The Landed card an agent puts in its reply once its work merged or reached
 * the default branch: `::source-control-landed{prs="…" commits="…" account="…"}`,
 * and the same card under its pre-cutover name `::code-review-landed`. It
 * lists each pull request and commit as GitHub reports it now and settles
 * the thread with bb's own Archive. Ported from
 * `plugins/code-review/src/app/landed-embed.tsx`.
 */
import {
  UrlLink,
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  useRpc,
  useSdk,
  type PluginBrowserBbSdk,
  type PluginMessageDirectiveProps,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canStillLand,
  commitKey,
  notLanded,
  parseLandedAttributes,
  prKey,
  sameCommit,
  sameRef,
  type CommitRef,
  type Landed,
  type LandedTarget,
  type PrRef,
} from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";

/** bb's own Archive, which the sidebar calls Settle. */
const ARCHIVE_KEYS = ["bb--core/archive"];
const PR_ICONS = { merged: "GitMerge", open: "GitPullRequest", closed: "GitPullRequestClosed" };
const POLL_MS = 60_000;

export function LandedDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const target = parseLandedAttributes(attributes);
  if (!target)
    return (
      <code data-bb-plugin="source-control" data-testid="sc-landed-invalid">
        {source}
      </code>
    );
  return <LandedCard target={target} threadId={message.threadId} />;
}

type Read =
  | { state: "loading" }
  | { state: "ready"; landed: Landed }
  | { state: "failed"; message: string };

/** GitHub's read of the card's list, again each minute while something can still land. */
function useLanded(target: LandedTarget) {
  const rpc = useRpc<typeof sourceControlContract>();
  const [read, setRead] = useState<Read>({ state: "loading" });
  const input = JSON.stringify(target);
  const [attempt, setAttempt] = useState(0);
  // A retry is a new request for the same target, so the effect reruns on it.
  const request = useMemo(() => ({ input, attempt }), [input, attempt]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const answer = await rpc.call("landedCard", JSON.parse(request.input) as LandedTarget);
        if (!live) return;
        if (answer.ok) {
          setRead({ state: "ready", landed: answer.landed });
          if (canStillLand(answer.landed)) timer = setTimeout(load, POLL_MS);
          return;
        }
        setRead((before) =>
          before.state === "ready" ? before : { state: "failed", message: answer.message },
        );
        if (answer.away) timer = setTimeout(load, POLL_MS);
      } catch (error) {
        if (live)
          setRead({
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, request]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { read, retry };
}

function LandedCard({ target, threadId }: { target: LandedTarget; threadId: string }) {
  const { read, retry } = useLanded(target);
  const data = read.state === "ready" ? read.landed : undefined;
  const total = target.prs.length + target.commits.length;
  const done = data ? total - notLanded(data).length : 0;
  const status = data
    ? done === total
      ? "Landed"
      : `${done} of ${total} landed`
    : read.state === "failed"
      ? "Unavailable"
      : "Checking";
  return (
    <section
      data-bb-plugin="source-control"
      data-testid="sc-landed-card"
      aria-label="Landed work"
      className="my-3 w-full max-w-[576px] overflow-hidden rounded-[8px] border border-solid border-border bg-background text-[12px] leading-4 text-foreground"
    >
      <div className="flex items-start gap-2.5 p-3 pb-1.5">
        <Icon
          name="CircleCheck"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>Source Control</span>
            <span aria-live="polite" className={status === "Landed" ? "text-success" : ""}>
              {status}
            </span>
          </div>
          <h3 className="m-0 mt-1 text-[12px] font-medium">
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
      {read.state === "failed" ? (
        <div role="alert" className="px-3 py-2 text-[11px] text-destructive-text">
          {read.message}{" "}
          <button type="button" className="cursor-pointer underline" onClick={retry}>
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

function PrRow({ refValue, read }: { refValue: PrRef; read?: Landed["prs"][number] }) {
  const label = read?.title ?? prKey(refValue);
  return (
    <li>
      <UrlLink
        href={
          read?.url ??
          `https://github.com/${refValue.owner}/${refValue.repo}/pull/${refValue.number}`
        }
        className="flex min-w-0 items-center gap-2 py-1 text-foreground no-underline"
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
      </UrlLink>
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
          {(read?.ref.sha ?? refValue.sha).slice(0, 7)}
        </span>
      </UrlLink>
    </li>
  );
}

type StoredThread = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["get"]>>;

/**
 * Settles the thread with bb's own Archive, so its confirmation, split-pane
 * cleanup and Undo toast all apply. The sidebar's live list answers for an
 * active thread; a thread missing from it is read from bb.
 */
function SettleButton({ threadId }: { threadId: string }) {
  const sidebar = useSidebarThreads();
  const row = sidebar.threads.find((each) => each.id === threadId);
  const sdk = useSdk();
  const [stored, setStored] = useState<StoredThread | null>(null);
  const [asked, setAsked] = useState(0);
  const needRead = row === undefined && sidebar.status === "ready";
  // Archiving asks again: each ask is a new read of the same thread.
  const readRequest = useMemo(
    () => (needRead ? { threadId, asked } : null),
    [needRead, threadId, asked],
  );
  useEffect(() => {
    if (!readRequest) return;
    let live = true;
    sdk.threads.get({ threadId: readRequest.threadId }).then(
      (thread) => live && setStored(thread),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sdk, readRequest]);
  const target = useMemo(
    () => (row ? rowTarget(row) : stored ? storedTarget(stored) : null),
    [row, stored],
  );
  if (target && target.archivedAt === null)
    return <ArchiveButton target={target} onDone={() => setAsked((n) => n + 1)} />;
  const settled = target !== null;
  return (
    <Button variant="outline" className="h-7 w-full gap-1.5 text-[12px]" disabled>
      {settled ? "Settled" : "Settle thread"}
      {settled ? <Icon name="Check" className="size-3" aria-hidden /> : null}
    </Button>
  );
}

function ArchiveButton({
  target,
  onDone,
}: {
  target: PluginThreadActionTarget;
  onDone: () => void;
}) {
  const [entry] = useThreadActions(target, { keys: ARCHIVE_KEYS });
  const [running, setRunning] = useState(false);
  return (
    <Button
      variant="default"
      data-testid="sc-landed-settle"
      className="h-7 w-full gap-1.5 text-[12px]"
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
            onDone();
          });
      }}
    >
      Settle thread
      <Icon name="Check" className="size-3" aria-hidden />
    </Button>
  );
}

/** The fields bb's thread actions read, from bb's own read of a thread the sidebar leaves out. */
function storedTarget(thread: StoredThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
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
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environment?.id == null ? null : { id: environment.id, path: environment.path ?? null },
  };
}
