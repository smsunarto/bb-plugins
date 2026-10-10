import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { toast } from "sonner";
import { AGENT_ACTIVITY_CHANNEL, prKey, prSubPath, sameRevision } from "../shared/schema.ts";
import type {
  AgentActivity,
  DiffRevision,
  Finding,
  LinkedThread,
  PrRef,
  PullRequest,
  ReviewRun,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { FindingCard, REVEAL_EVENT, sortFindings } from "./finding.tsx";
import type { RevealDetail } from "./finding.tsx";
import { PANEL_PATH, plural, relativeTime, shortSha } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { InlineError, Notice, RetryButton, Section, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";
import { Timestamp } from "./status.tsx";

/** How often linked threads are read again while one of them is working. */
const ACTIVITY_POLL_MS = 10_000;

/** The server's cap on stored review instructions. */
const INSTRUCTIONS_MAX = 8000;

// The statuses the server also counts as a review under way.
const BUSY: ReadonlySet<LinkedThread["status"]> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);

export function isBusy(thread: LinkedThread): boolean {
  return BUSY.has(thread.status);
}

/** The bb review thread still working on `revision`, if there is one. */
export function activeReview(
  activity: AgentActivity | undefined,
  revision: DiffRevision,
): LinkedThread | null {
  return (
    activity?.threads.find(
      (thread) => thread.kind === "review" && sameRevision(thread, revision) && isBusy(thread),
    ) ?? null
  );
}

/**
 * Threads linked to a pull request, kept current. The server publishes on
 * `AGENT_ACTIVITY_CHANNEL` when a thread goes idle or fails, or a review
 * reports. The poll covers signals missed while the connection was down.
 */
export function useAgentActivity(ref: PrRef) {
  // GitHub owners and repositories are case-insensitive, and the server
  // publishes the key in whatever case the thread was started with.
  const key = prKey(ref).toLowerCase();
  const activity = rpc.agentActivity.useQuery(
    { ref },
    {
      refetchInterval: (query) =>
        query.state.data?.threads.some(isBusy) ? ACTIVITY_POLL_MS : false,
    },
  );
  useRealtime(AGENT_ACTIVITY_CHANNEL, (payload) => {
    if (isActivityPayload(payload) && payload.key.toLowerCase() === key) {
      // Every part of the page that shows activity hears the same signal.
      // The first starts the read, and the rest join it instead of restarting it.
      void pluginQueryClient.invalidateQueries(
        { queryKey: rpc.agentActivity.queryKey({ ref }) },
        { cancelRefetch: false },
      );
    }
  });
  return activity;
}

function isActivityPayload(payload: unknown): payload is { key: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { key?: unknown }).key === "string"
  );
}

/**
 * Adds a just-started thread to the cached activity, so the button reads
 * "Reviewing…" at once instead of offering a second review until the refetch.
 */
function recordStarted(ref: PrRef, thread: LinkedThread): void {
  const queryKey = rpc.agentActivity.queryKey({ ref });
  pluginQueryClient.setQueryData<AgentActivity>(queryKey, (current) =>
    // Asked again while a review of this head runs, the server returns that review.
    current && !current.threads.some((linked) => linked.threadId === thread.threadId)
      ? { ...current, threads: [thread, ...current.threads] }
      : current,
  );
  void pluginQueryClient.invalidateQueries({ queryKey });
}

// ── Review with bb ────────────────────────────────────────────────────

/** The mark beside a bb review and its findings. Provider-neutral, since bb picks the agent. */
export function ReviewMark({ className }: { className?: string }) {
  return <Icon name="Bot" className={className} aria-hidden />;
}

// Outlined, so Submit review beside it stays the toolbar's one primary action.
const SPLIT = "h-7 text-xs max-md:pointer-coarse:h-9 [&_[data-icon-root]]:size-3.5";

/**
 * Starts a read-only review of the pull request's head on bb's default
 * agent. While one is running on this head, the button opens it instead of
 * starting another. The gear edits the instructions every review gets.
 */
export function ReviewWithBbButton({ pr }: { pr: PullRequest }) {
  const navigate = useBbNavigate();
  const activity = useAgentActivity(pr.ref);
  const running = activeReview(activity.data, pr);
  const [editing, setEditing] = useState(false);
  const start = rpc.startReview.useMutation({
    onSuccess({ threadId }) {
      recordStarted(pr.ref, {
        threadId,
        kind: "review",
        title: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
      });
      toast(`bb is reviewing #${pr.ref.number}`, {
        action: { label: "Open thread", onClick: () => navigate.toThread(threadId) },
      });
    },
    onError(error) {
      toast.error(errorText(error));
    },
  });

  return (
    <div className="flex shrink-0 items-center">
      <Button
        variant="outline"
        size="sm"
        className={cn(SPLIT, "gap-1.5 rounded-e-none px-2.5")}
        disabled={start.isPending}
        aria-busy={start.isPending}
        onClick={() => {
          if (running) navigate.toThread(running.threadId);
          else start.mutate({ ref: pr.ref });
        }}
      >
        {running || start.isPending ? (
          <Icon name="Loading" className="motion-safe:animate-spin" aria-hidden />
        ) : (
          <ReviewMark className="size-3.5" />
        )}
        {running ? "Reviewing…" : start.isPending ? "Starting…" : "Review with bb"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={cn(SPLIT, "-ms-px w-7 rounded-s-none px-0 max-md:pointer-coarse:w-9")}
        aria-label="bb review instructions"
        onClick={() => setEditing(true)}
      >
        <Icon name="Settings" aria-hidden />
      </Button>
      <ReviewInstructionsDialog open={editing} onOpenChange={setEditing} />
    </div>
  );
}

// ── Review instructions ──────────────────────────────────────────────────

/** Edits the standing instructions that go into every bb review prompt. */
export function ReviewInstructionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-3 text-xs">
        <DialogHeader>
          <DialogTitle>Review instructions</DialogTitle>
          <DialogDescription className="text-xs">
            Standing criteria and report format for every bb review
          </DialogDescription>
        </DialogHeader>
        {/* The content unmounts while closed, so each opening reads the saved text afresh. */}
        <InstructionsForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function InstructionsForm({ onDone }: { onDone: () => void }) {
  const stored = rpc.reviewInstructions.useQuery();
  if (stored.isPending) {
    return (
      <output aria-busy className="block">
        <span className="sr-only">Loading review instructions</span>
        <Skeleton className="h-48 w-full" />
      </output>
    );
  }
  if (stored.isError) {
    return (
      <Notice
        tone="error"
        title="Could not load the review instructions"
        action={<RetryButton onRetry={() => void stored.refetch()} />}
      >
        {errorText(stored.error)}
      </Notice>
    );
  }
  return <InstructionsEditor initial={stored.data.instructions} onDone={onDone} />;
}

function InstructionsEditor({ initial, onDone }: { initial: string; onDone: () => void }) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  // The text arrives after the dialog has placed focus, so it is moved here.
  useEffect(() => field.current?.focus(), []);
  const save = rpc.setReviewInstructions.useMutation({
    onSuccess(saved) {
      pluginQueryClient.setQueryData(rpc.reviewInstructions.queryKey(), saved);
      toast.success("Saved review instructions");
      onDone();
    },
  });
  const changed = text !== initial;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (changed && !save.isPending) save.mutate({ instructions: text });
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Textarea
        ref={field}
        aria-label="Review instructions"
        className="h-56 resize-y font-mono text-xs leading-relaxed"
        placeholder={
          "Flag missing tests for new endpoints.\nIgnore formatting. The linter handles it."
        }
        value={text}
        maxLength={INSTRUCTIONS_MAX}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      {save.isError ? <Notice tone="error">{errorText(save.error)}</Notice> : null}
      <DialogFooter className="items-center gap-2 sm:space-x-0">
        <span className="me-auto text-[11px] tabular-nums text-muted-foreground">
          {text.length.toLocaleString()} / {INSTRUCTIONS_MAX.toLocaleString()}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 text-xs"
          disabled={!changed || save.isPending}
          aria-busy={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ── Findings (Summary) ───────────────────────────────────────────────────

const SECTION_LINK = "ms-auto h-auto gap-1 p-0 text-[11px] font-normal [&_[data-icon-root]]:size-3";

/** Opens the Changes tab and asks it to scroll to the finding. */
function useRevealFinding(pr: PullRequest): (finding: Finding) => void {
  const navigate = useBbNavigate();
  return (finding) => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: prSubPath(pr.ref, "changes") });
    const detail: RevealDetail = { path: finding.path, line: finding.line, side: finding.side };
    // Navigation renders the Changes tab on a later frame. Two frames on,
    // it has mounted and is listening.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent<RevealDetail>(REVEAL_EVENT, { detail })),
      ),
    );
  };
}

/**
 * The latest bb review: its summary and findings, most urgent first. A
 * review still running on the head is said above them. Nothing at all until
 * the pull request has had a review.
 */
export function FindingsCard({ pr }: { pr: PullRequest }) {
  const activity = useAgentActivity(pr.ref);
  const reveal = useRevealFinding(pr);
  const run = activity.data?.latestReview ?? null;
  const running = activeReview(activity.data, pr);
  if (!run && !running) return null;
  const runThread = run
    ? activity.data?.threads.find((linked) => linked.threadId === run.threadId)
    : undefined;
  // A retarget changes the diff the reviewer read as surely as a push does.
  const stale = run !== null && !sameRevision(run, pr);

  return (
    <Section
      title="bb review"
      aside={
        <>
          {run ? <ReviewMeta run={run} stale={stale} pr={pr} /> : null}
          {/* The review on the head is the one to open, when there is one. */}
          <OpenThreadLink thread={running ?? runThread ?? null} />
        </>
      }
    >
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3">
        {running && running.threadId !== run?.threadId ? (
          <Reviewing headRefOid={pr.headRefOid} />
        ) : null}
        {run ? (
          <ReviewBody
            run={run}
            busy={runThread ? isBusy(runThread) : false}
            stale={stale}
            pr={pr}
            onReveal={reveal}
          />
        ) : null}
      </div>
    </Section>
  );
}

function OpenThreadLink({ thread }: { thread: LinkedThread | null }) {
  const navigate = useBbNavigate();
  if (!thread || thread.status === "missing") return null;
  return (
    <Button
      variant="link"
      size="sm"
      className={SECTION_LINK}
      onClick={() => navigate.toThread(thread.threadId)}
    >
      Open thread
      <Icon name="ArrowUpRight" aria-hidden />
    </Button>
  );
}

/** Said while a review runs: of the head, named when an older review's findings sit below. */
function Reviewing({ headRefOid }: { headRefOid?: string }) {
  return (
    <output className="flex items-center gap-1.5 text-muted-foreground">
      <Icon name="Loading" className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
      <span>
        bb is reviewing
        {headRefOid ? (
          <>
            {" "}
            <span className="font-mono" translate="no">
              {shortSha(headRefOid)}
            </span>
          </>
        ) : null}
        . Findings appear here when it reports.
      </span>
    </output>
  );
}

/** Why a review's findings may not match the diff any more. */
function staleReason(run: ReviewRun, pr: DiffRevision): string {
  return run.headRefOid === pr.headRefOid
    ? `bb reviewed the changes against ${run.baseRefName}. The pull request now targets ${pr.baseRefName}.`
    : `bb reviewed ${shortSha(run.headRefOid)}. The pull request is now at ${shortSha(pr.headRefOid)}.`;
}

function ReviewMeta({ run, stale, pr }: { run: ReviewRun; stale: boolean; pr: DiffRevision }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span translate="no" className="font-mono" title="The commit bb reviewed">
        {shortSha(run.headRefOid)}
      </span>
      {run.reportedAt ? (
        <>
          <span aria-hidden>·</span>
          <Timestamp iso={run.reportedAt} />
        </>
      ) : null}
      {stale ? (
        <span
          className="inline-flex h-4.5 items-center rounded-full bg-surface-attention px-1.5 text-[11px] font-semibold text-warning-text"
          title={staleReason(run, pr)}
        >
          Stale
        </span>
      ) : null}
    </span>
  );
}

function ReviewBody({
  run,
  busy,
  stale,
  pr,
  onReveal,
}: {
  run: ReviewRun;
  /** The run's own thread is still working. */
  busy: boolean;
  stale: boolean;
  pr: PullRequest;
  onReveal: (finding: Finding) => void;
}) {
  if (run.reportedAt === null) {
    return busy ? (
      <Reviewing />
    ) : (
      <p className="text-muted-foreground">
        The review ended without reporting findings. Open the thread to see what happened, or start
        another review.
      </p>
    );
  }
  const findings = sortFindings(run.findings);
  return (
    <>
      {run.summary?.trim() ? (
        <Markdown content={run.summary} className="min-w-0 text-xs [overflow-wrap:anywhere]" />
      ) : null}
      {findings.length === 0 ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Icon name="CircleCheck" className="size-3 text-success" aria-hidden />
          No findings.
        </p>
      ) : (
        <ul
          className="flex list-none flex-col gap-1.5"
          aria-label={plural(findings.length, "finding")}
        >
          {findings.map((finding) => (
            <li key={finding.id}>
              <FindingCard
                finding={finding}
                stale={stale}
                pr={pr}
                reviewed={run}
                onReveal={() => onReveal(finding)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Linked threads (Summary) ─────────────────────────────────────────────

const KIND_LABEL: Readonly<Record<LinkedThread["kind"], string>> = {
  review: "Review",
  fix: "Fix",
};

const STATUS_LOOK: Readonly<Record<LinkedThread["status"], { label: string; dot: string }>> = {
  pending: { label: "Queued", dot: "bg-attention" },
  starting: { label: "Starting", dot: "bg-attention motion-safe:animate-pulse" },
  active: { label: "Working", dot: "bg-attention motion-safe:animate-pulse" },
  stopping: { label: "Stopping", dot: "bg-attention" },
  idle: { label: "Idle", dot: "bg-success" },
  error: { label: "Failed", dot: "bg-destructive" },
  missing: { label: "Deleted", dot: "bg-muted-foreground/50" },
};

/** The thread's title, or what it was started to do when bb has none yet. */
export function linkedThreadTitle(thread: LinkedThread): string {
  if (thread.title?.trim()) return thread.title;
  return thread.kind === "review" ? "bb review" : "Fix checks";
}

/** Agent threads started from this pull request, newest first. Nothing when there are none. */
export function LinkedThreads({ pr }: { pr: PullRequest }) {
  const activity = useAgentActivity(pr.ref);
  const navigate = useBbNavigate();
  const threads = activity.data?.threads ?? [];
  if (!activity.isError && threads.length === 0) return null;
  return (
    <Section title="Agent threads">
      {activity.isError ? (
        <InlineError
          what="agent threads"
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : (
        <ul className="-mx-1.5 flex list-none flex-col">
          {threads.map((thread) => (
            <li key={thread.threadId}>
              <LinkedThreadRow
                thread={thread}
                current={thread.headRefOid === pr.headRefOid}
                onOpen={() => navigate.toThread(thread.threadId)}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function LinkedThreadRow({
  thread,
  current,
  onOpen,
}: {
  thread: LinkedThread;
  current: boolean;
  onOpen: () => void;
}) {
  const look = STATUS_LOOK[thread.status];
  const missing = thread.status === "missing";
  const title = linkedThreadTitle(thread);
  return (
    <button
      type="button"
      aria-label={`${title}: ${KIND_LABEL[thread.kind]} thread, ${look.label.toLowerCase()}, started ${relativeTime(thread.createdAt)}`}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-start hover:bg-state-hover disabled:cursor-default disabled:hover:bg-transparent",
        CONTROL_HOVER_TRANSITION,
      )}
      disabled={missing}
      onClick={onOpen}
    >
      <span className="flex h-4 shrink-0 items-center">
        <span className={cn("size-1.5 rounded-full", look.dot)} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("truncate", missing && "text-muted-foreground line-through")}
          title={title}
        >
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{KIND_LABEL[thread.kind]}</span>
          <span aria-hidden>·</span>
          <span>{look.label}</span>
          <span aria-hidden>·</span>
          <Timestamp iso={thread.createdAt} className="tabular-nums" />
          {current ? null : (
            <>
              <span aria-hidden>·</span>
              <span
                className="truncate font-mono"
                title="Started on an older commit"
                translate="no"
              >
                {shortSha(thread.headRefOid)}
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}
