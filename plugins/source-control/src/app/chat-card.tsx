/**
 * The Change card an agent puts in its reply (board B), from the directive
 * `::source-control{key="<encoded ChangeKey>" revision="<head>"}`. The
 * attributes are untrusted: the key is decoded and validated before any
 * read. The card reads the Change and its review by key, only while it is
 * on screen, and says when it shows an old read, could not read, or the
 * Change has moved past the revision the agent wrote about.
 *
 * An agent can also write the directive by hand, with no tool call:
 * `::source-control` alone is this thread's work as it is now, which
 * `thread-card.tsx` draws, and `::source-control{pr="owner/repo#12"}` is a
 * pull request anywhere, resolved on the server as the cutover's cards are.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  useBbNavigate,
  useRealtimeConnectionState,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { describeProblem, readAgo, type CheckRow } from "../core/change.ts";
import { parseDirective, parseGroup } from "../core/directive.ts";
import type { ChangeKey } from "../core/ids.ts";
import { reviewPath, type ChangeDetail } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { FindingList, OpenReviewArrow, fixLabel } from "./findings-card.tsx";
import { cx, plural, shortId } from "./format.ts";
import { PANEL_PATH, useNow } from "./page/hooks.ts";
import { STATE_CHIP } from "./page/rail.tsx";
import type { ChangeState } from "../core/status.ts";
import { useChangeReview, useReviewActions } from "./review-data.ts";
import { MergeButton, mergeTarget, readyToMerge, useChangeMerge } from "./merge.tsx";
import { latestBatch } from "./review-model.ts";
import { BatchLine, useFixSelected } from "./send.tsx";
import { ChangeGroup } from "./group-card.tsx";
import { LegacyCards, pullRequestTarget } from "./legacy-card.tsx";
import { ThreadCard, uncommittedLine, type ThreadShip } from "./thread-card.tsx";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";

type Ready = Extract<ChangeDetail, { state: "change" }>;

/** True once the element has been on screen; IntersectionObserver reports it without forcing layout. */
/** The chip for `changeState`, the words the composer strip leads with. */
function statusChip(status: ChangeState): { label: string; className: string } {
  const tone = status.tone === "pushed" ? "local" : status.tone;
  return { label: status.label, className: STATE_CHIP[tone].className };
}

export function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const [onScreen, setOnScreen] = useState(seen);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      setOnScreen(entry.isIntersecting);
      if (entry.isIntersecting) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return seen && onScreen;
}

export const CARD =
  "flex w-full max-w-[576px] min-w-0 flex-col overflow-clip rounded-[8px] border border-solid border-border bg-background text-start font-sans text-foreground";

function BranchGlyph() {
  return (
    <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
      <svg width="15" height="15" viewBox="0 0 10 10" className="shrink-0">
        <g fill="none" stroke="var(--tertiary-foreground)" strokeWidth="0.9" strokeLinecap="round">
          <circle cx="2.5" cy="2" r="1.2" />
          <circle cx="2.5" cy="8" r="1.2" />
          <circle cx="7.5" cy="8" r="1.2" />
          <path d="M2.5 3.2V6.8M7.5 6.8V4.5C7.5 3.4 6.9 2.8 5.8 2.8H5" />
        </g>
      </svg>
    </span>
  );
}

function ChecksChip({ rows }: { rows: readonly CheckRow[] }) {
  const failed = rows.filter((row) => row.outcome === "failed").length;
  const running = rows.filter((row) => row.outcome === "pending").length;
  if (rows.length === 0) return null;
  const [text, tone, dot] =
    failed > 0
      ? [`${failed} Failed`, "text-destructive-text", "bg-destructive"]
      : running > 0
        ? [`${running} Running`, "text-warning", "bg-warning"]
        : ["Passed", "text-success-foreground", "bg-success"];
  return (
    <span
      className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-solid border-border px-2"
      data-testid="sc-card-checks"
    >
      <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", dot)} />
      <span className={cx("text-[11px] leading-4 font-medium whitespace-pre", tone)}>{text}</span>
    </span>
  );
}

export function CardSkeleton() {
  return (
    <div
      className={CARD}
      aria-busy="true"
      aria-label="Reading this change"
      data-testid="sc-card-loading"
    >
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-56 max-w-full" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-3 border-t border-solid border-border px-3 py-3">
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-72 max-w-full" />
        <Skeleton className="h-3.5 w-52 max-w-full" />
      </div>
      <div className="flex gap-2 px-3 pt-1 pb-3">
        <Skeleton className="h-7 flex-1" />
        <Skeleton className="h-7 flex-1" />
      </div>
    </div>
  );
}

export function CardNote({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className={cx(CARD, "gap-2 p-3")} data-testid={testId}>
      {children}
    </div>
  );
}

/** The card's head (board B): state, number and branch, size, title and checks, then any caveat. */
function CardHeader({
  detail,
  revision,
  visible,
  offline,
  uncommitted,
}: {
  detail: Ready;
  revision: string | null;
  visible: boolean;
  offline: boolean;
  /** The checkout's uncommitted files, on a thread's own card. */
  uncommitted: number;
}) {
  const { row } = detail;
  const now = useNow();
  const checks = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "checksForChange",
    keys: [row.key],
    enabled: visible && row.number !== null,
  });
  const checkRows = checks.data?.[row.key]?.read?.value?.rows ?? [];
  const chip = statusChip(detail.status);
  const head = detail.head;
  const moved =
    revision !== null && head !== null && !head.startsWith(revision) && !revision.startsWith(head);
  let stale: string | null = null;
  if (offline) stale = "Offline. This is what bb last read.";
  else if (detail.problem) stale = `${describeProblem(detail.problem)} This is what bb last read.`;
  const size = [
    detail.files !== null ? (
      <span key="files" className="text-[11px] leading-4 text-(--tertiary-foreground)">
        {plural(detail.files, "file")}
      </span>
    ) : null,
    detail.additions !== null ? (
      <span key="add" className="font-mono text-[11px] leading-4 text-success-foreground">
        +{detail.additions}
      </span>
    ) : null,
    detail.deletions !== null ? (
      <span key="del" className="font-mono text-[11px] leading-4 text-destructive-text">
        −{detail.deletions}
      </span>
    ) : null,
  ];
  return (
    <div className="flex min-w-0 items-start gap-2 p-3">
      <BranchGlyph />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cx(
              "flex h-4 shrink-0 items-center rounded-full px-2 text-[11px] leading-3 font-semibold",
              chip.className,
            )}
          >
            {chip.label}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-(--tertiary-foreground)">
            {row.number !== null ? `#${row.number} · ${row.branch}` : row.branch}
          </span>
          <span className="flex shrink-0 items-center gap-2">{size}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-5 font-semibold break-words text-foreground">
            {row.title}
          </span>
          <ChecksChip rows={checkRows} />
        </div>
        {moved ? (
          <span className="text-[12px] leading-4 text-muted-foreground" data-testid="sc-card-moved">
            The change moved past this revision ({shortId(revision)}); this is its head now,{" "}
            {shortId(head)}.
          </span>
        ) : null}
        {uncommitted > 0 ? (
          <span
            className="text-[12px] leading-4 text-muted-foreground"
            data-testid="sc-card-uncommitted-count"
          >
            {uncommittedLine(uncommitted)}
          </span>
        ) : null}
        {stale ? (
          <span className="text-[12px] leading-4 text-muted-foreground" data-testid="sc-card-stale">
            {stale} {readAgo(detail.at, now)}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** "Merge it" on a Change whose pull request is ready: today's merge dialog, pinned to the head shown. */
function CardMerge({ detail }: { detail: Ready }) {
  const submit = useChangeMerge();
  const target = mergeTarget(detail);
  if (!target) return null;
  return (
    <MergeButton
      submit={submit}
      target={target}
      label="Merge it"
      variant="default"
      testId="sc-card-merge"
      className="min-w-0 flex-[1_1_8rem]"
    />
  );
}

function ReadyCard({
  detail,
  revision,
  threadId,
  visible,
  offline,
  grouped,
  thread,
}: {
  detail: Ready;
  revision: string | null;
  threadId: string;
  visible: boolean;
  offline: boolean;
  /** On a grouped card, whose Merge all merges it. */
  grouped: boolean;
  /** On a thread's own card: its uncommitted files and Ship it. */
  thread: ThreadShip | null;
}) {
  const key = detail.row.key;
  const navigate = useBbNavigate();
  const { stable } = useChangeReview(key, visible);
  const actions = useReviewActions(key);
  const fix = useFixSelected(key, stable, detail.head, threadId);
  const batch = latestBatch(stable.batches);
  const hasItems = stable.items.length > 0;
  return (
    <div className={CARD} data-testid="sc-card" data-key={key}>
      <CardHeader
        detail={detail}
        revision={revision}
        visible={visible}
        offline={offline}
        uncommitted={thread?.uncommitted ?? 0}
      />
      {hasItems ? (
        <FindingList
          changeKey={key}
          stable={stable}
          actions={actions}
          className="border-t border-solid border-border px-3 py-2"
        />
      ) : null}
      {batch?.destination === "agent" ? (
        <div className="flex min-w-0 px-3 pb-1">
          <BatchLine
            changeKey={key}
            batch={batch}
            here={batch.target.kind === "thread" && batch.target.threadId === threadId}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap gap-2 px-3 pt-1 pb-3">
        <Button
          variant="outline"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: reviewPath({ key }) })}
          className="min-w-0 flex-[1_1_8rem] gap-2 px-3"
        >
          Open review
          <OpenReviewArrow />
        </Button>
        {thread?.button}
        {!grouped && readyToMerge(detail) ? <CardMerge detail={detail} /> : null}
        {hasItems ? (
          <Button
            variant="default"
            data-testid="sc-card-fix"
            disabled={fix.count === 0 || fix.pending || detail.head === null}
            onClick={fix.fix}
            className="min-w-0 flex-[1_1_8rem] px-3 font-semibold"
          >
            {fixLabel(fix)}
          </Button>
        ) : null}
      </div>
      {thread?.sent ? (
        <output className="px-3 pb-3 text-[12px] leading-4 text-muted-foreground">
          {thread.sent}
        </output>
      ) : null}
      {fix.error ? (
        <span role="alert" className="px-3 pb-3 text-[12px] leading-4 text-warning">
          {fix.error}
        </span>
      ) : null}
    </div>
  );
}

export function ChangeCard({
  changeKey,
  revision,
  threadId,
  grouped = false,
  thread = null,
}: {
  changeKey: ChangeKey;
  revision: string | null;
  threadId: string;
  grouped?: boolean;
  thread?: ThreadShip | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const connection = useRealtimeConnectionState();
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys: [changeKey],
    enabled: visible,
  });
  const detail = query.data?.[changeKey];
  let body;
  if (!detail || detail.state === "pending")
    body =
      query.error && !detail ? (
        <CardNote testId="sc-card-failed">
          <p role="alert" className="m-0 text-[13px] leading-5 text-muted-foreground">
            Couldn't read this change. {query.error.message}
          </p>
          <div>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        </CardNote>
      ) : (
        <CardSkeleton />
      );
  else if (detail.state === "missing")
    body = (
      <CardNote testId="sc-card-missing">
        <p className="m-0 text-[13px] leading-5 text-muted-foreground">
          {detail.problem
            ? describeProblem(detail.problem)
            : "bb doesn't know this change. Its branch may have been deleted."}
        </p>
      </CardNote>
    );
  else
    body = (
      <ReadyCard
        detail={detail}
        revision={revision}
        threadId={threadId}
        visible={visible}
        offline={connection !== "connected"}
        grouped={grouped}
        thread={thread}
      />
    );
  return (
    <div ref={root} data-bb-plugin="source-control" className="@container my-2 flex w-full min-w-0">
      {body}
    </div>
  );
}

/** `::source-control{key revision}`, `{changes}` for several, `{pr}` for a pull request, or alone for the thread's own work. */
export function ChangeDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const group = useMemo(() => {
    const entries = parseGroup(attributes);
    return entries?.map((entry) => ({ id: entry.key, entry }));
  }, [attributes]);
  if (group) return <ChangeGroup items={group} threadId={message.threadId} />;
  if (attributes.key === undefined && attributes.changes === undefined)
    return <HandWritten pr={attributes.pr} threadId={message.threadId} />;
  return <OneChange attributes={attributes} threadId={message.threadId} />;
}

/** Written by the agent, not returned by the tool: a pull request it names, else this thread's own work. */
function HandWritten({ pr, threadId }: { pr: string | undefined; threadId: string }) {
  const targets = useMemo(() => {
    const target = pr === undefined ? null : pullRequestTarget(pr);
    return target ? [target] : null;
  }, [pr]);
  if (targets) return <LegacyCards targets={targets} threadId={threadId} />;
  if (pr !== undefined)
    return (
      <span
        data-bb-plugin="source-control"
        data-testid="sc-card-invalid"
        className="text-[12px] leading-4 text-muted-foreground"
      >
        This is not a pull request bb can read. Name it as owner/repo#123 or by its GitHub URL.
      </span>
    );
  return <ThreadCard threadId={threadId} />;
}

function OneChange({
  attributes,
  threadId,
}: {
  attributes: PluginMessageDirectiveProps["attributes"];
  threadId: string;
}) {
  const parsed = parseDirective(attributes);
  if (!parsed)
    return (
      <span
        data-bb-plugin="source-control"
        data-testid="sc-card-invalid"
        className="text-[12px] leading-4 text-muted-foreground"
      >
        This link to a change is not one bb can read.
      </span>
    );
  return (
    <ChangeCard
      key={parsed.key}
      changeKey={parsed.key}
      revision={parsed.revision}
      threadId={threadId}
    />
  );
}
