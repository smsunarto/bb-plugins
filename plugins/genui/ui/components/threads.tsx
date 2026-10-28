// Threads: live status of BB threads (project_threads): the reply's thread's
// subthreads, or the ids the spec names (only threads of the same project; any
// other id says it isn't found). Each row says what the thread is doing: its
// status (an idle parent of running workers waits on them), the question or
// approval it waits on, and its latest message (two lines, expandable). A row
// opens the thread in BB. It polls, with backoff, only while visible and while
// a thread is running or waiting on running workers.
import { useMemo, useState } from "react";
import { experimental_ProviderIcon as ProviderIcon, Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  parseThreadIds,
  relativeTime,
  RUNNING,
  type ThreadInfo,
  type ThreadsResult,
  type ThreadsView,
} from "../../core/project";
import {
  previewText,
  threadActivityLabel,
  waitsOnWorkers,
  workersLabel,
  type LastMessage,
  type PendingAsk,
} from "../../core/thread-activity";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { usePersistedState } from "../usePersistedState";
import { formatNumber, TONE_DOT, TONE_TEXT, type Props, type Tone } from "../values";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import {
  EXACT_TIME,
  FailureLine,
  Freshness,
  LoadingRows,
  NeedsThread,
  Panel,
  QuietLine,
  ShowAll,
  useNow,
  useProjectQuery,
  useVisible,
} from "./projectKit";

const COLLAPSED_THREADS = 8;
const COLLAPSE_FROM = 11;

/** A thread's status color: needs input warns, a failure is bad, running is the accent. Environments uses it too. */
export function statusTone(thread: Pick<ThreadInfo, "needsInput" | "status">): Tone {
  if (thread.needsInput) return "warn";
  if (thread.status === "error") return "bad";
  return RUNNING[thread.status] ? "info" : "neutral";
}

export function Threads({ props }: { props: Props }) {
  const { threadId } = useUiRuntime();
  const ids = parseThreadIds(props.ids);
  if (!ids.ok) return <ErrorLine message={ids.error} />;
  if (threadId === null) {
    return (
      <NeedsThread icon="Workflow">
        <span className="font-medium text-foreground">Threads</span> needs a thread: in a reply it shows live status of
        {ids.value === null ? " that thread's subthreads" : " the threads named, in that thread's project"}.
      </NeedsThread>
    );
  }
  return <ThreadsPanel threadId={threadId} ids={ids.value} />;
}

function ThreadsPanel({ threadId, ids }: { threadId: string; ids: readonly string[] | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const { query, refresh } = useProjectQuery<ThreadsResult>(
    `threads\0${threadId}\0${JSON.stringify(ids)}`,
    () => rpc.call("project_threads", { threadId, ids: ids === null ? null : [...ids] }),
    {
      visible,
      live: (answer) => answer.ok && answer.threads.some((thread) => thread.found && (RUNNING[thread.status] || waitsOnWorkers(thread))),
    },
  );
  const now = useNow(15_000);
  const answer = query.status === "ready" ? query.answer : null;
  const view = answer?.ok ? answer : null;
  const running = view === null ? 0 : view.threads.filter((thread) => thread.found && RUNNING[thread.status]).length;
  const waiting = view === null ? 0 : view.threads.filter((thread) => thread.found && thread.needsInput).length;
  return (
    <div ref={ref} className="min-w-0">
      <Panel
        label={ids === null ? "Subthreads" : "Threads"}
        header={
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon name="Workflow" aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">{ids === null ? "Subthreads" : "Threads"}</span>
              {view === null ? null : <span className="tabular-nums">{formatNumber(view.threads.length)}{view.truncated ? "+" : ""}</span>}
            </span>
            {running > 0 ? (
              <span className="flex items-center gap-1.5 tabular-nums">
                <LiveDot tone="info" live />
                {running} running
              </span>
            ) : null}
            {waiting > 0 ? <span className={cn("tabular-nums", TONE_TEXT.warn)}>{waiting} need input</span> : null}
            {view === null ? null : (
              <Freshness at={view.fetchedAt} stored={false} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
            )}
          </>
        }
      >
        {answer === null ? (
          <LoadingRows label="Loading threads" />
        ) : !answer.ok ? (
          <FailureLine failure={answer} />
        ) : (
          <ThreadList view={answer} now={now} />
        )}
      </Panel>
    </div>
  );
}

/** A status dot; a running thread's dot pulses inside a soft halo (and holds still under reduced motion). */
export function LiveDot({ tone, live }: { tone: Tone; live: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        TONE_DOT[tone],
        live && "animate-pulse shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-timeline-accent,var(--primary))_22%,transparent)] motion-reduce:animate-none",
      )}
    />
  );
}

function ThreadList({ view, now }: { view: ThreadsView; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  if (view.threads.length === 0) {
    return (
      <QuietLine className="px-3 py-2.5">
        {view.mode === "subthreads" ? "This thread has no subthreads." : "No threads named."}
      </QuietLine>
    );
  }
  const collapsed = !expanded && view.threads.length >= COLLAPSE_FROM;
  const shown = collapsed ? view.threads.slice(0, COLLAPSED_THREADS) : view.threads;
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0">
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {shown.map((thread) =>
            thread.found ? <ThreadRow key={thread.id} thread={thread} now={now} /> : <MissingRow key={thread.id} id={thread.id} />,
          )}
        </ul>
        {collapsed ? <ShowAll count={view.threads.length} noun="threads" onClick={() => setExpanded(true)} /> : null}
        {view.truncated ? (
          <QuietLine icon="Info" className="border-t border-border/60 px-3 py-2">
            Only the first {formatNumber(view.threads.length)} subthreads are listed.
          </QuietLine>
        ) : null}
      </div>
    </div>
  );
}

/** BB's glyph per kind of thing a thread waits on the user for. */
const PENDING_ICON: Record<PendingAsk["kind"], string> = {
  question: "MessageQuestion",
  approval: "SecurityCheck",
  plan: "ListTodo",
  request: "FileQuestion",
};

/** What the button that opens the thread to act on a pending ask says. */
const PENDING_VERB: Record<PendingAsk["kind"], string> = {
  question: "Answer",
  approval: "Review",
  plan: "Review",
  request: "Respond",
};

function ThreadRow({ thread, now }: { thread: ThreadInfo; now: number }) {
  const navigate = useBbNavigate();
  const rise = useEntrance<HTMLLIElement>(RISE);
  const waiting = waitsOnWorkers(thread);
  const tone = waiting ? "info" : statusTone(thread);
  const agent = thread.provider.name ?? thread.provider.id;
  const open = () => navigate.toThread(thread.id);
  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={open}
        title={`Open “${thread.title}”`}
        className={cn(
          "group/row flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-state-hover",
          FOCUS_RING,
        )}
      >
        <LiveDot tone={tone} live={RUNNING[thread.status] || waiting} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium leading-5 text-foreground">{thread.title}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className={cn("shrink-0 font-medium", TONE_TEXT[tone])}>{threadActivityLabel(thread)}</span>
            <span aria-hidden>·</span>
            <span className="flex min-w-0 items-center gap-1">
              <ProviderIcon
                providerKind="agent"
                provider={{ id: thread.provider.id, logoUrl: thread.provider.logoUrl }}
                fallback="Bot"
                aria-hidden
                className="size-3 shrink-0"
              />
              <span className="min-w-0 truncate">
                {agent}
                {thread.model === null ? "" : ` · ${thread.model}`}
                {thread.reasoning === null ? "" : ` · ${thread.reasoning} reasoning`}
              </span>
            </span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(thread.updatedAt).toISOString()} title={`Last activity ${EXACT_TIME.format(thread.updatedAt)}`} className="shrink-0 tabular-nums">
              {relativeTime(thread.updatedAt, now)}
            </time>
            {thread.runningWorkers > 0 && !waiting ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">{workersLabel(thread.runningWorkers)}</span>
              </>
            ) : null}
          </span>
        </span>
        <Icon
          name="ChevronRight"
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/row:text-foreground"
        />
      </button>
      {thread.pending === null && thread.lastMessage === null ? null : (
        // Indented to the title: the dot (8 px) and its gap (10 px) after the row's padding (12 px).
        <div className="flex min-w-0 flex-col gap-1.5 pb-2.5 pl-[30px] pr-3">
          {thread.pending === null ? null : <PendingCard pending={thread.pending} now={now} onOpen={open} />}
          {thread.lastMessage === null ? null : <LatestMessage threadId={thread.id} message={thread.lastMessage} onOpen={open} />}
        </div>
      )}
    </li>
  );
}

/** What the thread waits on the user for: the ask, the question or command, the options; acting on it happens in the thread. */
function PendingCard({ pending, now, onOpen }: { pending: PendingAsk; now: number; onOpen: () => void }) {
  const meta = [pending.since > 0 ? `asked ${relativeTime(pending.since, now)}` : "", pending.more > 0 ? `${pending.more} more waiting` : ""]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <div role="group" aria-label="Waiting for you" className="min-w-0 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs leading-5">
      <div className="flex min-w-0 items-start gap-1.5">
        <Icon name={PENDING_ICON[pending.kind]} fallback="Info" aria-hidden className="mt-[3px] size-3.5 shrink-0 text-warning-text" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-warning-text">{pending.action}</span>
          {meta === "" ? null : <span className="tabular-nums text-muted-foreground"> · {meta}</span>}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "-my-0.5 inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors duration-150 hover:bg-state-hover",
            FOCUS_RING,
          )}
        >
          {PENDING_VERB[pending.kind]}
          <Icon name="ChevronRight" aria-hidden className="size-3" />
        </button>
      </div>
      {pending.text === null ? null : pending.code ? (
        <code title={pending.text} className="mt-1 line-clamp-3 min-w-0 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">
          {pending.text}
        </code>
      ) : (
        <p className="m-0 mt-0.5 line-clamp-3 text-foreground [overflow-wrap:anywhere]">{pending.text}</p>
      )}
      {pending.options.length === 0 ? null : (
        <ul aria-label="Options" className="m-0 mt-1 flex min-w-0 list-none flex-wrap gap-1 p-0">
          {pending.options.map((option, index) => (
            <li key={index} className="max-w-full truncate rounded border border-border bg-background px-1.5 text-[11px] leading-[18px] text-muted-foreground">
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The thread's latest message: two lines of plain text; expanded, the message as BB renders it. */
function LatestMessage({ threadId, message, onOpen }: { threadId: string; message: LastMessage; onOpen: () => void }) {
  const [expanded, setExpanded] = usePersistedState(`threads:message:${threadId}`, false, (stored) => (typeof stored === "boolean" ? stored : null));
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const preview = useMemo(() => previewText(message.text), [message.text]);
  const link = cn(
    "inline-flex cursor-pointer items-center gap-0.5 rounded text-muted-foreground transition-colors duration-150 hover:text-foreground",
    FOCUS_RING,
  );
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0 border-l-2 border-border pl-2.5">
        {expanded ? (
          <>
            <Markdown
              content={message.text}
              className="max-h-80 min-w-0 overflow-y-auto text-[13px] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
            />
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 text-[11px] leading-4">
              <button type="button" aria-expanded onClick={() => setExpanded(false)} className={link}>
                Show less
                <Icon name="ChevronUp" aria-hidden className="size-3" />
              </button>
              {message.truncated ? (
                <button type="button" onClick={onOpen} className={link}>
                  The message goes on in the thread
                  <Icon name="ChevronRight" aria-hidden className="size-3" />
                </button>
              ) : null}
            </span>
          </>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
            title="Show the whole message"
            className={cn("group/message block w-full min-w-0 cursor-pointer rounded-sm text-left", FOCUS_RING)}
          >
            <span className="sr-only">Latest message: </span>
            <span className="line-clamp-2 text-xs leading-[18px] text-muted-foreground transition-colors duration-150 [overflow-wrap:anywhere] group-hover/message:text-foreground">
              {preview}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function MissingRow({ id }: { id: string }) {
  return (
    <li className="flex min-w-0 items-center gap-2.5 border-b border-border/60 px-3 py-2 last:border-b-0">
      <span aria-hidden className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-xs leading-5 text-muted-foreground">{id}</span>
        <span className="text-[11px] leading-4 text-muted-foreground">Not found in this project</span>
      </span>
    </li>
  );
}
