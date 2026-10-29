import { MarkdownEditor, type MarkdownEditorHandle } from "@bb-plugins/markdown-editor";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import { queryClient } from "./query.ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AGENT_ACTIVITY_CHANNEL,
  branchKey,
  branchSubPath,
  prKey,
  prSubPath,
  sameRevision,
} from "../shared/schema.ts";
import type {
  AgentActivity,
  DiffRevision,
  Finding,
  LinkedThread,
  LocalComparison,
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
import { FindingCard, REVEAL_EVENT, sortFindings } from "./finding.tsx";
import type { RevealDetail } from "./finding.tsx";
import { PANEL_PATH, plural, relativeTime, shortSha } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { InlineError, Notice, RetryButton, Section, errorText } from "./notice.tsx";
import { queryKey, useRpcQuery, useRpcMutation, useCodeReviewRpc, type Client } from "./rpc.ts";
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
 * What a bb review reads: a pull request, or an unpublished branch. Every
 * part below takes one, as its `pr` or its `branch` prop.
 */
export type ReviewTarget =
  | { pr: PullRequest; branch?: undefined }
  | { branch: LocalComparison & { branch: string }; pr?: undefined };

/** Everything a pull request and a branch differ in, for the parts that show bb's work. */
export type ReviewSubject = {
  /** The diff a review started now reads, and findings are current against. */
  revision: DiffRevision;
  /** What bb is said to be reviewing: `#42`, or the branch's name. */
  name: string;
  noun: "pull request" | "branch";
  /** The page's subPath of its Changes tab. */
  changesPath: string;
  /** The pull request findings can become draft comments on. A branch has none. */
  pr: PullRequest | null;
  /** What the server publishes on `AGENT_ACTIVITY_CHANNEL` for it, lowercased. */
  key: string;
  activityKey: QueryKey;
  readActivity: (client: Client) => Promise<AgentActivity>;
  startReview: (client: Client) => Promise<{ threadId: string }>;
};

/** The one place that tells a pull request's bb review from a branch's. */
export function reviewSubject(target: ReviewTarget): ReviewSubject {
  if (target.pr) {
    const { pr } = target;
    return {
      revision: { headRefOid: pr.headRefOid, baseRefName: pr.baseRefName },
      name: `#${pr.ref.number}`,
      noun: "pull request",
      changesPath: prSubPath(pr.ref, "changes", pr.account),
      pr,
      // GitHub owners and repositories are case-insensitive, and the server
      // publishes the key in whatever case the thread was started with.
      key: prKey(pr.ref).toLowerCase(),
      activityKey: queryKey("agentActivity", { ref: pr.ref }),
      readActivity: (client) => client.call("agentActivity", { ref: pr.ref }),
      startReview: (client) => client.call("startReview", { account: pr.account, ref: pr.ref }),
    };
  }
  const { branch } = target;
  return {
    // The base is a commit, so a rebase reads as another revision too.
    revision: { headRefOid: branch.head, baseRefName: branch.base },
    name: branch.branch,
    noun: "branch",
    changesPath: branchSubPath(branch.id, "changes"),
    pr: null,
    key: branchKey(branch.id),
    activityKey: queryKey("branchActivity", { id: branch.id }),
    readActivity: (client) => client.call("branchActivity", { id: branch.id }),
    startReview: (client) => client.call("startLocalReview", { id: branch.id }),
  };
}

/**
 * Threads linked to a pull request or branch, kept current. The server
 * publishes on `AGENT_ACTIVITY_CHANNEL` when a thread goes idle or fails, or
 * a review reports. The poll covers signals missed while the connection was
 * down.
 */
export function useAgentActivity(target: ReviewTarget) {
  const subject = reviewSubject(target);
  const client = useCodeReviewRpc();
  // Read through the client, so one hook serves either rpc. The cache key is the rpc's own.
  const activity = useQuery({
    queryKey: subject.activityKey,
    queryFn: () => subject.readActivity(client),
    refetchInterval: (query) => (query.state.data?.threads.some(isBusy) ? ACTIVITY_POLL_MS : false),
  });
  useRealtime(AGENT_ACTIVITY_CHANNEL, (payload) => {
    if (isActivityPayload(payload) && payload.key.toLowerCase() === subject.key) {
      // Every part of the page that shows activity hears the same signal.
      // The first starts the read, and the rest join it instead of restarting it.
      void queryClient.invalidateQueries(
        { queryKey: subject.activityKey },
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
function recordStarted(subject: ReviewSubject, thread: LinkedThread): void {
  const queryKey = subject.activityKey;
  queryClient.setQueryData<AgentActivity>(queryKey, (current) =>
    // Asked again while a review of this head runs, the server returns that review.
    current && !current.threads.some((linked) => linked.threadId === thread.threadId)
      ? { ...current, threads: [thread, ...current.threads] }
      : current,
  );
  void queryClient.invalidateQueries({ queryKey });
}

// ── Review with bb ────────────────────────────────────────────────────

/** The mark beside a bb review and its findings. Provider-neutral, since bb picks the agent. */
export function ReviewMark({ className }: { className?: string }) {
  return <Icon name="Bot" className={className} aria-hidden />;
}

// Outlined, so Submit review beside it stays the toolbar's one primary action.
const SPLIT = "h-7 text-xs max-md:pointer-coarse:h-9 [&_[data-icon-root]]:size-3.5";

/**
 * Starts a read-only review of the pull request's or branch's head on bb's
 * default agent. While one is running on this head, the button opens it
 * instead of starting another.
 */
export function ReviewWithBbButton(target: ReviewTarget) {
  const subject = reviewSubject(target);
  const navigate = useBbNavigate();
  const client = useCodeReviewRpc();
  const activity = useAgentActivity(target);
  const running = activeReview(activity.data, subject.revision);
  const start = useMutation({
    mutationFn: () => subject.startReview(client),
    onSuccess({ threadId }) {
      recordStarted(subject, {
        threadId,
        kind: "review",
        title: null,
        status: "pending",
        createdAt: new Date().toISOString(),
        ...subject.revision,
      });
      toast(`bb is reviewing ${subject.name}`, {
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
        className={cn(SPLIT, "gap-1.5 px-2.5")}
        disabled={start.isPending}
        aria-busy={start.isPending}
        onClick={() => {
          if (running) navigate.toThread(running.threadId);
          else start.mutate();
        }}
      >
        {running || start.isPending ? (
          <Icon name="Loading" className="motion-safe:animate-spin" aria-hidden />
        ) : (
          <ReviewMark className="size-3.5" />
        )}
        {running ? "Reviewing…" : start.isPending ? "Starting…" : "Review with bb"}
      </Button>
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
  const stored = useRpcQuery("reviewInstructions", null);
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
  const field = useRef<MarkdownEditorHandle>(null);
  // The text arrives after the dialog has placed focus, so it is moved here.
  useEffect(() => field.current?.focus(), []);
  const save = useRpcMutation("setReviewInstructions", {
    onSuccess(saved) {
      queryClient.setQueryData(queryKey("reviewInstructions"), saved);
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
      <MarkdownEditor
        ref={field}
        aria-label="Review instructions"
        className="h-56 resize-y font-mono text-xs leading-relaxed"
        placeholder={
          "Flag missing tests for new endpoints.\nIgnore formatting. The linter handles it."
        }
        value={text}
        maxLength={INSTRUCTIONS_MAX}
        onChange={setText}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
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

/** Opens the Changes tab at `changesPath` and asks it to scroll to the finding. */
function useRevealFinding(changesPath: string): (finding: Finding) => void {
  const navigate = useBbNavigate();
  return (finding) => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: changesPath });
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
 * the pull request or branch has had a review.
 */
export function FindingsCard(target: ReviewTarget) {
  const subject = reviewSubject(target);
  const activity = useAgentActivity(target);
  const reveal = useRevealFinding(subject.changesPath);
  const run = activity.data?.latestReview ?? null;
  const running = activeReview(activity.data, subject.revision);
  if (!run && !running) return null;
  const runThread = run
    ? activity.data?.threads.find((linked) => linked.threadId === run.threadId)
    : undefined;
  // A retarget changes the diff the reviewer read as surely as a push does.
  const stale = run !== null && !sameRevision(run, subject.revision);

  return (
    <Section
      title="bb review"
      aside={
        <>
          {run ? <ReviewMeta run={run} stale={stale} subject={subject} /> : null}
          {/* The review on the head is the one to open, when there is one. */}
          <OpenThreadLink thread={running ?? runThread ?? null} />
        </>
      }
    >
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-3.5 py-3">
        {running && running.threadId !== run?.threadId ? (
          <Reviewing headRefOid={subject.revision.headRefOid} />
        ) : null}
        {run ? (
          <ReviewBody
            run={run}
            busy={runThread ? isBusy(runThread) : false}
            stale={stale}
            pr={subject.pr}
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
function staleReason(run: ReviewRun, { revision, noun, pr }: ReviewSubject): string {
  if (run.headRefOid !== revision.headRefOid) {
    return `bb reviewed ${shortSha(run.headRefOid)}. The ${noun} is now at ${shortSha(revision.headRefOid)}.`;
  }
  // A pull request's base is the branch it targets; a branch's, the commit it starts from.
  return pr
    ? `bb reviewed the changes against ${run.baseRefName}. The pull request now targets ${revision.baseRefName}.`
    : `bb reviewed the changes from ${shortSha(run.baseRefName)}. The branch now starts from ${shortSha(revision.baseRefName)}.`;
}

function ReviewMeta({
  run,
  stale,
  subject,
}: {
  run: ReviewRun;
  stale: boolean;
  subject: ReviewSubject;
}) {
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
          title={staleReason(run, subject)}
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
  /** The pull request findings can be drafted on. None for a branch. */
  pr: PullRequest | null;
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

/** Agent threads started from this pull request or branch, newest first. Nothing when there are none. */
export function LinkedThreads(target: ReviewTarget) {
  const { revision } = reviewSubject(target);
  const activity = useAgentActivity(target);
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
                current={thread.headRefOid === revision.headRefOid}
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
