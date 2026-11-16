/**
 * Sending (board A4): the review page's destination toggle and Send button
 * with its tray, the sent batch's pill and the rail's banner, and the
 * compact line the thread tab's and the chat's cards show after "Fix N
 * selected". The tray is a view of the Change's one shared review entry: the
 * items checked anywhere and the pending drafts.
 *
 * A send mints its batch id once; Retry sends a queued or failed batch again
 * under its own id, so nothing is ever sent twice. Nothing retries by itself.
 */
import {
  ThreadTitle,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { describeProblem, type Problem } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import type {
  AgentTarget,
  BatchTarget,
  BatchView,
  Destination,
  Draft,
  ReviewItem,
} from "../core/items.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx, plural } from "./format.ts";
import { useChangeReview, useReviewActions, useSend, type SendActions } from "./review-data.ts";
import {
  batchLabel,
  batchThread,
  draftSpot,
  itemTitle,
  latestBatch,
  placeLabel,
  sendableDrafts,
  type StableReview,
} from "./review-model.ts";
import { PriorityChip, RunGlyph } from "./review-ui.tsx";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.tsx";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.tsx";
import { Hint, ReasonHint, TEXT_LINK } from "./ui.tsx";
import { FocusContext, type Spot } from "./page/review-focus.ts";

/** The review's send actions keep the theme's accent, not the default foreground fill. */
const PRIMARY =
  "bg-(--primary) px-3 font-semibold text-primary-foreground enabled:hover:bg-(--primary) enabled:hover:opacity-90";

const SECTION_LABEL =
  "m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase";

// ── Marks ──────────────────────────────────────────────────────────────

function Robot({ size, className }: { size: 12 | 13; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      className={cx("shrink-0", className)}
    >
      <path
        d="M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
      <path
        d="M3 4.5L6 7.5L9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A sent batch's mark: the dashed ring while it is under way, never a "done" tick for an agent. */
function PhaseGlyph({ batch }: { batch: BatchView }) {
  switch (batch.phase) {
    case "sending":
    case "fixing":
    case "queued":
      return <RunGlyph state="running" />;
    case "failed":
      return <RunGlyph state="failed" />;
    case "posted":
      return <RunGlyph state="done" />;
    case "verify":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--primary)" strokeWidth="1.4" />
        </svg>
      );
    case "stopped":
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
          <circle
            cx="6"
            cy="6"
            r="4.4"
            fill="none"
            stroke="var(--tertiary-foreground)"
            strokeWidth="1.4"
          />
        </svg>
      );
  }
}

/** The thread's title, or "the agent thread" while bb's thread list does not have it. */
export function ThreadName({
  threadId,
  title,
}: {
  threadId: string | null;
  title?: string | null;
}) {
  if (title) return <>{title}</>;
  if (!threadId) return <>a new agent thread</>;
  return (
    // bb renders the title as `whitespace-pre truncate` segments meant for a flex row:
    // an inline flex box lets them shrink to the line instead of overflowing it. The
    // mention-pill rule mirrors bb's own `.bb-thread-title .prompt-mention-pill`.
    <span className="inline-flex max-w-full min-w-0 items-baseline overflow-hidden empty:before:content-['the_agent_thread'] [&_.prompt-mention-pill]:min-w-10 [&_.prompt-mention-pill]:flex-[1_1_0%] [&_.prompt-mention-pill]:max-w-max">
      <ThreadTitle threadId={threadId} />
    </span>
  );
}

// ── Batch outcome: pill, banner, compact line ─────────────────────────

type BatchCommands = {
  retry(): void;
  stop(): void;
  openThread: (() => void) | null;
  busy: boolean;
  error: string | null;
};

/** Retry, Stop and Open thread for one batch, each reporting what went wrong. */
function useBatchCommands(send: SendActions, batch: BatchView | null): BatchCommands {
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const run = useCallback(async (id: string, work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    let text: string | null;
    try {
      text = await work();
    } catch (reason) {
      text = reason instanceof Error ? reason.message : "The request failed.";
    }
    setBusy(false);
    if (text) setError({ id, text });
  }, []);
  const thread = batch ? batchThread(batch) : null;
  return {
    retry: () => {
      if (batch) void run(batch.id, async () => (await send.retry(batch), null));
    },
    stop: () => {
      if (batch)
        void run(batch.id, async () => {
          const result = await send.stop(batch.id);
          return result.ok ? null : result.message;
        });
    },
    openThread: thread ? () => navigate.toThread(thread, { split: true }) : null,
    busy,
    error: error && batch && error.id === batch.id ? error.text : null,
  };
}

function problemText(batch: BatchView): string {
  return batch.problem
    ? describeProblem(batch.problem)
    : batch.phase === "queued"
      ? "Waiting for its destination to answer."
      : "It was not sent.";
}

/** The header's pill once a batch is sent (board A4): "Agent working on 2 · Open thread". */
function BatchPill({ batch, commands }: { batch: BatchView; commands: BatchCommands }) {
  let action: ReactNode = null;
  if (batch.phase === "posted")
    action = batch.url ? (
      <Button variant="link" size="sm" className={TEXT_LINK} asChild>
        <a href={batch.url} target="_blank" rel="noreferrer">
          View
        </a>
      </Button>
    ) : null;
  else if (batch.phase === "queued" || batch.phase === "failed")
    action = (
      <Button
        variant="link"
        size="sm"
        className={TEXT_LINK}
        disabled={commands.busy}
        onClick={commands.retry}
        data-testid="sc-batch-retry"
      >
        Retry
      </Button>
    );
  else if (commands.openThread)
    action = (
      <Button variant="link" size="sm" className={TEXT_LINK} onClick={commands.openThread}>
        Open thread
      </Button>
    );
  return (
    <Badge
      variant="outline"
      className="h-6 min-w-0 gap-2 px-3"
      data-testid="sc-batch-pill"
      data-phase={batch.phase}
    >
      <PhaseGlyph batch={batch} />
      <Hint
        label={batch.phase === "queued" || batch.phase === "failed" ? problemText(batch) : null}
      >
        <span className="min-w-0 truncate text-[12px] leading-4 font-semibold text-foreground">
          {batchLabel(batch)}
        </span>
      </Hint>
      {action}
    </Badge>
  );
}

function SentCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="7" cy="7" r="6" fill="var(--success)" />
      <path
        d="M4.2 7.2L6.2 9.1L9.8 5.2"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function bannerText(batch: BatchView, thread: ReactNode): ReactNode {
  const count = batch.itemIds.length + batch.draftIds.length;
  switch (batch.phase) {
    case "sending":
      return (
        <>
          Sending {count} to {thread}…
        </>
      );
    case "fixing":
      return (
        <>
          Sent {count} to {thread}
        </>
      );
    case "verify":
      return <>The agent made a new commit. Verify the {plural(count, "fix", "fixes")}.</>;
    case "stopped":
      return batch.agent === "idle" ? (
        <>The agent replied without a new commit.</>
      ) : (
        <>The agent stopped without a new commit.</>
      );
    case "posted":
      return <>Posted {plural(count, "comment")} to GitHub</>;
    case "queued":
    case "failed":
      return <>{problemText(batch)}</>;
  }
}

/** The batch above the rail's Review section (board A4's confirmation). */
export const BatchBanner = memo(function BatchBanner({
  changeKey,
  batch,
}: {
  changeKey: ChangeKey;
  batch: BatchView;
}) {
  const send = useSend(changeKey);
  const commands = useBatchCommands(send, batch);
  const thread = <ThreadName threadId={batchThread(batch)} />;
  let action: ReactNode = null;
  if (batch.phase === "fixing")
    action = (
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0"
        disabled={commands.busy}
        onClick={commands.stop}
        data-testid="sc-batch-stop"
      >
        {commands.busy ? "Stopping…" : "Stop agent"}
      </Button>
    );
  else if (batch.phase === "queued" || batch.phase === "failed")
    action = (
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0"
        disabled={commands.busy}
        onClick={commands.retry}
        data-testid="sc-batch-retry"
      >
        Retry
      </Button>
    );
  else if (batch.phase === "posted" && batch.url)
    action = (
      <Button variant="outline" size="sm" className="h-7 shrink-0" asChild>
        <a href={batch.url} target="_blank" rel="noreferrer">
          View
        </a>
      </Button>
    );
  else if ((batch.phase === "verify" || batch.phase === "stopped") && commands.openThread)
    action = (
      <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={commands.openThread}>
        Open thread
      </Button>
    );
  const bad = batch.phase === "queued" || batch.phase === "failed";
  const oneLine = batch.phase === "sending" || batch.phase === "fixing";
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-[8px] border border-solid border-border-hairline bg-surface-recessed p-3"
      data-testid="sc-batch-banner"
      data-phase={batch.phase}
    >
      <div className="flex min-w-0 items-center gap-2">
        {batch.phase === "fixing" || batch.phase === "posted" ? (
          <SentCheck />
        ) : (
          <PhaseGlyph batch={batch} />
        )}
        <span
          className={cx(
            "min-w-0 flex-1 text-[13px] leading-5",
            // "Sent N to <thread>" stays on one line; the thread title truncates.
            oneLine ? "flex items-baseline whitespace-pre" : "[overflow-wrap:anywhere]",
            bad ? "text-warning" : "text-foreground",
          )}
        >
          {bannerText(batch, thread)}
        </span>
        {action}
      </div>
      {commands.error ? (
        <span role="alert" className="text-[12px] leading-4 text-warning">
          {commands.error}
        </span>
      ) : null}
    </div>
  );
});

/** A card's compact report on its last batch: mark, label, then Retry, Stop or Open thread. */
export function BatchLine({
  changeKey,
  batch,
  here,
}: {
  changeKey: ChangeKey;
  batch: BatchView;
  /** The card is in the batch's own thread: no Open thread. */
  here: boolean;
}) {
  const send = useSend(changeKey);
  const commands = useBatchCommands(send, batch);
  let action: ReactNode = null;
  if (batch.phase === "queued" || batch.phase === "failed")
    action = (
      <Button
        variant="link"
        size="sm"
        className={TEXT_LINK}
        disabled={commands.busy}
        onClick={commands.retry}
        data-testid="sc-batch-retry"
      >
        Retry
      </Button>
    );
  else if (batch.phase === "fixing")
    action = (
      <Button
        variant="link"
        size="sm"
        className={TEXT_LINK}
        disabled={commands.busy}
        onClick={commands.stop}
      >
        Stop agent
      </Button>
    );
  else if (!here && commands.openThread)
    action = (
      <Button variant="link" size="sm" className={TEXT_LINK} onClick={commands.openThread}>
        Open thread
      </Button>
    );
  return (
    <span
      className="flex min-w-0 items-center gap-2"
      data-testid="sc-batch-line"
      data-phase={batch.phase}
    >
      <PhaseGlyph batch={batch} />
      <Hint
        label={batch.phase === "queued" || batch.phase === "failed" ? problemText(batch) : null}
      >
        <span className="min-w-0 truncate text-[12px] leading-4 font-semibold text-foreground">
          {batchLabel(batch)}
        </span>
      </Hint>
      {action}
      {commands.error ? (
        <span role="alert" className="min-w-0 truncate text-[12px] leading-4 text-warning">
          {commands.error}
        </span>
      ) : null}
    </span>
  );
}

// ── Fix N selected (thread tab and chat cards) ────────────────────────

export type FixSelected = {
  count: number;
  fix(): void;
  pending: boolean;
  error: string | null;
};

/** The checked items, not already being fixed, sent to `threadId` as one agent batch. */
export function useFixSelected(
  changeKey: ChangeKey,
  stable: StableReview,
  head: string | null,
  threadId: string,
): FixSelected {
  const send = useSend(changeKey);
  const [error, setError] = useState<string | null>(null);
  const ids = useMemo(
    () =>
      stable.items
        .filter((item) => stable.selected.has(item.id) && !stable.fixing.has(item.id))
        .map((item) => item.id),
    [stable.items, stable.selected, stable.fixing],
  );
  return {
    count: ids.length,
    pending: send.pending,
    error,
    fix: () => {
      if (ids.length === 0 || !head) return;
      setError(null);
      send
        .send({
          head,
          itemIds: ids,
          draftIds: [],
          destination: "agent",
          target: { kind: "thread", threadId },
        })
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : "Couldn't send."),
        );
    },
  };
}

// ── The review page's controls and tray ───────────────────────────────

/** Why GitHub can't take this review, or null when it can. */
export function githubBlocked(number: number | null, problem: Problem | null): string | null {
  if (number === null) return "This change has no pull request on GitHub yet.";
  if (problem?.kind === "no-site") return describeProblem(problem);
  return null;
}

const SEGMENT = "min-w-0 rounded-sm data-[state=on]:font-semibold";
/** Desktop's tab row, or the phone's bottom bar, whose controls are finger-sized. */
const SEGMENT_SIZE = {
  row: "h-6 px-3 text-[12px] leading-4",
  bar: "h-8 px-3.5 text-[13px] leading-5",
} as const;
type ControlSize = keyof typeof SEGMENT_SIZE;

/** Where the review goes: the agent, or GitHub when the Change has a pull request there. */
function DestinationToggle({
  destination,
  blocked,
  size,
  onChange,
}: {
  destination: Destination;
  blocked: string | null;
  size: ControlSize;
  onChange: (destination: Destination) => void;
}) {
  const segment = cx(SEGMENT, SEGMENT_SIZE[size]);
  return (
    <ToggleGroup
      type="single"
      aria-label="Review goes to"
      value={destination}
      // A single group reports "" when its pressed item is pressed again: one destination stays chosen.
      onValueChange={(next) => {
        if (next) onChange(next as Destination);
      }}
      className="shrink-0 gap-0 rounded-md bg-surface-raised p-1"
    >
      <ToggleGroupItem value="agent" data-testid="sc-destination-agent" className={segment}>
        Agent
      </ToggleGroupItem>
      <ReasonHint reason={blocked}>
        <ToggleGroupItem
          value="github"
          disabled={blocked !== null}
          data-testid="sc-destination-github"
          className={segment}
        >
          GitHub
        </ToggleGroupItem>
      </ReasonHint>
    </ToggleGroup>
  );
}

type TrayFacts = {
  changeKey: ChangeKey;
  stable: StableReview;
  destination: Destination;
  number: number | null;
  isDraft: boolean;
  head: string | null;
  items: readonly ReviewItem[];
  drafts: readonly Draft[];
  onExclude: (id: string) => void;
  onSent: () => void;
  onClose: () => void;
};

/** A tray row's text: a button that shows its spot on the diff, or plain text off the review page. */
function TrayPick({
  spot,
  onReveal,
  className,
  children,
}: {
  spot: Spot;
  onReveal: ((spot: Spot) => void) | null;
  className: string;
  children: ReactNode;
}) {
  if (!onReveal) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      data-testid="sc-tray-reveal"
      onClick={() => onReveal(spot)}
      className={cx(
        className,
        "group/pick cursor-pointer rounded-sm border-0 bg-transparent p-0 text-start",
      )}
    >
      {children}
    </button>
  );
}

const TrayItem = memo(function TrayItem({
  item,
  onRemove,
  onReveal,
}: {
  item: ReviewItem;
  onRemove: (id: string) => void;
  onReveal: ((spot: Spot) => void) | null;
}) {
  const title = itemTitle(item);
  return (
    <li
      className="flex h-8 min-w-0 shrink-0 items-center gap-2"
      data-testid="sc-tray-item"
      data-item={item.id}
    >
      {item.priority !== null ? <PriorityChip priority={item.priority} /> : null}
      <TrayPick spot={item} onReveal={onReveal} className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground group-hover/pick:underline"
          title={title}
        >
          {title}
        </span>
        <span className="shrink-0 text-[12px] leading-4 text-(--tertiary-foreground)">
          {placeLabel(item.anchor)}
        </span>
      </TrayPick>
      <Button variant="link" size="sm" className={TEXT_LINK} onClick={() => onRemove(item.id)}>
        Remove
      </Button>
    </li>
  );
});

const TrayDraft = memo(function TrayDraft({
  draft,
  on,
  spot,
  onRemove,
  onReveal,
}: {
  draft: Draft;
  /** What it answers, or where it sits. */
  on: string;
  spot: Spot;
  onRemove: (id: string) => void;
  onReveal: ((spot: Spot) => void) | null;
}) {
  return (
    <li
      className="flex min-w-0 items-start gap-2 py-1"
      data-testid="sc-tray-draft"
      data-draft={draft.id}
    >
      <TrayPick spot={spot} onReveal={onReveal} className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere] group-hover/pick:underline">
          {draft.body}
        </span>
        <span className="truncate text-[12px] leading-4 text-(--tertiary-foreground)">{on}</span>
      </TrayPick>
      <Button
        variant="link"
        size="sm"
        className={cx(TEXT_LINK, "leading-5")}
        onClick={() => onRemove(draft.id)}
      >
        Remove
      </Button>
    </li>
  );
});

function TargetPicker({
  targets,
  error,
  onPick,
  onRetry,
}: {
  targets: readonly AgentTarget[] | undefined;
  error: string | null;
  onPick: (target: BatchTarget) => void;
  onRetry: () => void;
}) {
  const row =
    "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[6px] border-0 bg-transparent px-2 text-start text-[12px] leading-4 text-foreground hover:bg-surface-raised";
  return (
    <div
      className="flex flex-col gap-1 border-b border-solid border-border-hairline px-2 py-2"
      data-testid="sc-tray-targets"
    >
      {targets === undefined ? (
        error ? (
          <div className="flex items-center gap-2 px-2">
            <span className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
              Couldn't list threads. {error}
            </span>
            <Button variant="link" size="sm" className={TEXT_LINK} onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <div
            aria-busy="true"
            aria-label="Listing threads"
            className="flex flex-col gap-2 px-2 py-1"
          >
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-40" />
          </div>
        )
      ) : (
        <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
          {targets.map((target) => (
            <li key={target.threadId}>
              <button
                type="button"
                className={row}
                onClick={() => onPick({ kind: "thread", threadId: target.threadId })}
              >
                <Robot size={12} />
                <span className="min-w-0 flex-1 truncate">
                  <ThreadName threadId={target.threadId} title={target.title} />
                </span>
                {target.onChange ? (
                  <span className="shrink-0 text-[11px] leading-4 text-(--tertiary-foreground)">
                    On this branch
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={row}
        data-testid="sc-tray-new-thread"
        onClick={() => onPick({ kind: "new-thread" })}
      >
        <span aria-hidden className="w-3 shrink-0 text-center">
          +
        </span>
        New thread in this project
      </button>
    </div>
  );
}

/** The tray's agent target: the kept one, else the first thread on this branch, else a new thread. */
function agentTarget(
  kept: BatchTarget | null,
  targets: readonly AgentTarget[] | undefined,
): BatchTarget | null {
  if (kept && kept.kind !== "pull-request") return kept;
  if (!targets) return null;
  const first = targets.find((target) => target.onChange);
  return first ? { kind: "thread", threadId: first.threadId } : { kind: "new-thread" };
}

function trayNote(facts: {
  error: string | null;
  agent: boolean;
  target: BatchTarget | null;
  isDraft: boolean;
  number: number | null;
}): string {
  if (facts.error) return `Couldn't send. ${facts.error}`;
  if (!facts.agent) return `Posted as one review on #${facts.number}, on the head you read.`;
  const where = facts.target?.kind === "new-thread" ? "a new thread" : "that thread";
  const draft = facts.isDraft && facts.number !== null ? ` #${facts.number} stays a draft.` : "";
  return `The agent answers or fixes each in ${where}, replying under it.${draft}`;
}

/** "Going to <thread> · Change thread", and the picker it opens. */
function TrayRecipient({
  changeKey,
  agent,
  number,
  target,
  targets,
  targetsError,
  destination,
  onRetry,
}: {
  changeKey: ChangeKey;
  agent: boolean;
  number: number | null;
  target: BatchTarget | null;
  targets: readonly AgentTarget[] | undefined;
  targetsError: string | null;
  destination: Destination;
  onRetry: () => void;
}) {
  const actions = useReviewActions(changeKey);
  const [picking, setPicking] = useState(false);
  let recipient: ReactNode = "GitHub";
  if (!agent) recipient = number !== null ? `#${number} on GitHub` : "GitHub";
  else if (!target) recipient = "Choosing a thread…";
  else if (target.kind === "new-thread") recipient = "New thread in this project";
  else if (target.kind === "thread")
    recipient = (
      <ThreadName
        threadId={target.threadId}
        title={targets?.find((entry) => entry.threadId === target.threadId)?.title ?? null}
      />
    );
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 border-b border-solid border-border-hairline px-4 py-3">
        <span className="shrink-0 text-[12px] leading-4 text-(--tertiary-foreground)">
          Going to
        </span>
        <span
          className="flex h-6 min-w-0 items-center gap-2 rounded-full bg-surface-raised px-2 text-foreground"
          data-testid="sc-tray-recipient"
        >
          <Robot size={12} />
          <span className="min-w-0 truncate text-[12px] leading-4 font-semibold">{recipient}</span>
        </span>
        <span className="min-w-0 flex-1" />
        {agent ? (
          <Button
            variant="link"
            size="sm"
            className={TEXT_LINK}
            aria-expanded={picking}
            data-testid="sc-tray-change-thread"
            onClick={() => setPicking((value) => !value)}
          >
            Change thread
          </Button>
        ) : null}
      </div>
      {picking && agent ? (
        <TargetPicker
          targets={targets}
          error={targetsError}
          onPick={(picked) => {
            setPicking(false);
            actions.setTray({ destination, target: picked });
          }}
          onRetry={onRetry}
        />
      ) : null}
    </>
  );
}

/** "Findings to fix · n" and "Your replies · n", each row with Remove. */
function TrayLists({
  stable,
  items,
  drafts,
  onRemoveItem,
  onExclude,
  onReveal,
}: {
  stable: StableReview;
  items: readonly ReviewItem[];
  drafts: readonly Draft[];
  onRemoveItem: (id: string) => void;
  onExclude: (id: string) => void;
  /** Closes the tray and scrolls the diff to a row's line; null off the review page. */
  onReveal: ((spot: Spot) => void) | null;
}) {
  const byId = useMemo(() => new Map(stable.items.map((item) => [item.id, item])), [stable.items]);
  if (items.length + drafts.length === 0)
    return (
      <p className="m-0 px-4 py-3 text-[12px] leading-4 text-muted-foreground">
        Nothing to send yet. Check findings in the review, or leave a comment on a line.
      </p>
    );
  return (
    <>
      {items.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 px-4 pt-3 pb-2">
          <div className="pb-1">
            <h3 className={SECTION_LABEL}>Findings to fix · {items.length}</h3>
          </div>
          <ul className="m-0 flex max-h-64 list-none flex-col overflow-y-auto p-0">
            {items.map((item) => (
              <TrayItem key={item.id} item={item} onRemove={onRemoveItem} onReveal={onReveal} />
            ))}
          </ul>
        </div>
      ) : null}
      {drafts.length > 0 ? (
        <div
          className={cx(
            "flex min-w-0 flex-col gap-1 px-4 pt-2 pb-3",
            items.length > 0 && "border-t border-solid border-border-hairline",
          )}
        >
          <div className="pb-1">
            <h3 className={SECTION_LABEL}>Your replies · {drafts.length}</h3>
          </div>
          <ul className="m-0 flex max-h-56 list-none flex-col overflow-y-auto p-0">
            {drafts.map((draft) => {
              const answers = draft.replyTo ? byId.get(draft.replyTo) : undefined;
              return (
                <TrayDraft
                  key={draft.id}
                  draft={draft}
                  on={answers ? `On ${itemTitle(answers)}` : `On ${placeLabel(draft.anchor)}`}
                  spot={draftSpot(draft, byId)}
                  onRemove={onExclude}
                  onReveal={onReveal}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function Tray(facts: TrayFacts) {
  const { changeKey, stable, destination, number, head, items, drafts } = facts;
  const actions = useReviewActions(changeKey);
  const send = useSend(changeKey);
  const [error, setError] = useState<string | null>(null);
  const agent = destination === "agent";
  const targetsQuery = useRpcQuery({
    contract: sourceControlContract,
    method: "agentTargets",
    input: { key: changeKey },
    enabled: agent,
  });
  const targets = targetsQuery.data?.targets;
  const prTarget: BatchTarget | null = number !== null ? { kind: "pull-request", number } : null;
  const target = agent ? agentTarget(stable.tray.target, targets) : prTarget;
  const onRemoveItem = useCallback((id: string) => actions.setSelected([id], false), [actions]);
  const focus = useContext(FocusContext);
  const { onClose } = facts;
  const onReveal = useMemo(
    () =>
      focus
        ? (spot: Spot) => {
            onClose();
            focus.reveal(spot);
          }
        : null,
    [focus, onClose],
  );
  const count = items.length + drafts.length;
  const canSend = count > 0 && target !== null && head !== null && !send.pending;
  const onSend = async () => {
    if (!canSend) return;
    setError(null);
    try {
      await send.send({
        head,
        itemIds: items.map((item) => item.id),
        draftIds: drafts.map((draft) => draft.id),
        destination,
        target,
      });
      facts.onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't send.");
    }
  };
  return (
    <>
      <TrayRecipient
        changeKey={changeKey}
        agent={agent}
        number={number}
        target={target}
        targets={targets}
        targetsError={targetsQuery.error?.message ?? null}
        destination={destination}
        onRetry={() => void targetsQuery.refetch()}
      />
      <TrayLists
        stable={stable}
        items={items}
        drafts={drafts}
        onRemoveItem={onRemoveItem}
        onExclude={facts.onExclude}
        onReveal={onReveal}
      />
      <div className="flex min-w-0 items-center gap-3 border-t border-solid border-border-hairline bg-surface-recessed px-4 py-3">
        <span
          className={cx(
            "min-w-0 flex-1 text-[12px] leading-4",
            error ? "text-warning" : "text-(--tertiary-foreground)",
          )}
          data-testid="sc-tray-note"
          role={error ? "alert" : undefined}
        >
          {trayNote({ error, agent, target, isDraft: facts.isDraft, number })}
        </span>
        <Button
          size="sm"
          variant="default"
          data-testid="sc-tray-send"
          disabled={!canSend}
          onClick={() => void onSend()}
          className={cx("h-7", PRIMARY)}
        >
          {sendLabel(send.pending, agent, count)}
        </Button>
      </div>
    </>
  );
}

function sendLabel(pending: boolean, agent: boolean, count: number): string {
  if (pending) return "Sending…";
  return agent ? `Send ${count}` : `Submit ${count}`;
}

/** The checked items and pending drafts a send would carry, and the drafts taken out of it. */
function useTraySelection(stable: StableReview, destination: Destination) {
  // Drafts the reader took out of this send; they stay drafts.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(
    () =>
      stable.items.filter(
        (item) =>
          stable.selected.has(item.id) &&
          !stable.fixing.has(item.id) &&
          // GitHub already has its own threads: a review carries bb's findings only.
          (destination === "agent" || item.origin.kind === "bb"),
      ),
    [stable.items, stable.selected, stable.fixing, destination],
  );
  const drafts = useMemo(
    () => sendableDrafts(stable.drafts).filter((draft) => !excluded.has(draft.id)),
    [stable.drafts, excluded],
  );
  const onExclude = useCallback((id: string) => setExcluded((old) => new Set(old).add(id)), []);
  const reset = useCallback(() => setExcluded(new Set()), []);
  return { items, drafts, onExclude, reset };
}

/** The Send button's words; in the bar its toggle sits beside it and already names the destination. */
function triggerLabel(destination: Destination, count: number, bar: boolean): string {
  if (destination === "github") return bar ? "Submit" : "Submit to GitHub";
  const send = count > 0 ? `Send ${count}` : "Send";
  return bar ? send : `${send} to agent`;
}

/** The pill shows while a batch is under way, and after it until something new is checked. */
function showsPill(batch: BatchView | null, count: number): batch is BatchView {
  if (!batch) return false;
  const settled = batch.phase === "posted" || batch.phase === "stopped" || batch.phase === "verify";
  return !settled || count === 0;
}

/**
 * The tabs row's review controls (board A): where the review goes, the sent
 * batch's pill, and the Send button that opens the tray: a Popover, which
 * closes on Escape, a click outside or focus leaving it.
 */
export const SendControls = memo(function SendControls({
  changeKey,
  number,
  isDraft,
  head,
  size = "row",
}: {
  changeKey: ChangeKey;
  number: number | null;
  isDraft: boolean;
  head: string | null;
  size?: ControlSize;
}) {
  const { review, stable } = useChangeReview(changeKey);
  const actions = useReviewActions(changeKey);
  const send = useSend(changeKey);
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  const blocked = githubBlocked(number, review?.forge.problem ?? null);
  const destination: Destination =
    stable.tray.destination === "github" && blocked === null ? "github" : "agent";
  const { items, drafts, onExclude, reset } = useTraySelection(stable, destination);
  const batch = latestBatch(stable.batches);
  const commands = useBatchCommands(send, batch);
  const count = items.length + drafts.length;
  const pill = showsPill(batch, count);
  const bar = size === "bar";
  const label = triggerLabel(destination, count, bar);
  return (
    <div
      className={cx(
        "ms-auto flex min-w-0 items-center justify-end self-center",
        bar ? "flex-wrap gap-2" : "flex-wrap gap-3 py-1",
      )}
      data-testid="sc-send-controls"
    >
      <span className="hidden shrink-0 text-[12px] leading-4 text-(--tertiary-foreground) @3xl:inline">
        Review goes to
      </span>
      <DestinationToggle
        destination={destination}
        blocked={blocked}
        size={size}
        onChange={(next) => actions.setTray({ destination: next, target: stable.tray.target })}
      />
      {pill ? <BatchPill batch={batch} commands={commands} /> : null}
      {!pill || count > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="default"
              data-testid="sc-send"
              // Matches the destination toggle's 32px; on a phone the pseudo-element makes the tap target 40px tall.
              className={cx(
                PRIMARY,
                size === "bar"
                  ? "h-10 gap-2 rounded-md px-4 text-[14px] [&_svg]:size-3.5"
                  : "relative h-8 gap-2 [&_svg]:size-3 max-md:pointer-coarse:after:absolute max-md:pointer-coarse:after:-inset-y-1 max-md:pointer-coarse:after:inset-x-0",
              )}
            >
              {destination === "agent" ? <Robot size={13} /> : null}
              {label}
              <ChevronDown />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={8}
            aria-label="Send tray"
            mobileTitle="Send tray"
            data-testid="sc-tray"
            className="flex w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-clip p-0"
          >
            <Tray
              changeKey={changeKey}
              stable={stable}
              destination={destination}
              number={number}
              isDraft={isDraft}
              head={head}
              items={items}
              drafts={drafts}
              onExclude={onExclude}
              onSent={() => {
                setOpen(false);
                reset();
              }}
              onClose={onClose}
            />
          </PopoverContent>
        </Popover>
      ) : null}
      {commands.error ? (
        <span role="alert" className="min-w-0 truncate text-[12px] leading-4 text-warning">
          {commands.error}
        </span>
      ) : null}
    </div>
  );
});
