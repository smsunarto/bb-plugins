/**
 * The composer strip (board B): the thread's Change in one line above the
 * composer, with Ship it once its branch is pushed without a pull request
 * and Mark ready while it is a draft. A thread context segment,
 * so it mounts only for threads that have a Change.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo, useState } from "react";
import type { ThreadChange } from "../core/change.ts";
import {
  attentionChips,
  changeState,
  conflictsWithBase,
  primaryAction,
  summarize,
  type ChangeState,
  type ChangeSummary,
} from "../core/status.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";
import { Pending } from "./ui.tsx";
import { useDraftToggle } from "./status.tsx";
import { Button } from "./components/ui/button.tsx";

/** bb's own changed-files segment, which already counts uncommitted files. */
const CHANGED_FILES_SEGMENT = "bb--git/changed-files";

/** The thread's Change from the same keyed read the tab uses, so both share one read. */
function useThreadChange(threadId: string, enabled: boolean): ThreadChange | undefined {
  const keys = useMemo(() => [threadId], [threadId]);
  const query = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeForThread",
    keys,
    enabled,
  });
  return query.data?.[threadId];
}

/** A Change the strip can speak for: a read checkout with a branch of the thread's own. */
function stripSummary(row: ThreadChange | undefined): ChangeSummary | null {
  const summary = summarize(row);
  return summary?.branch ? summary : null;
}

export function useStripVisible(input: ExperimentalThreadContextSegmentInput): boolean {
  return stripSummary(useThreadChange(input.threadId, input.environment !== null)) !== null;
}

type Part = { text: string; tone: string; icon?: string };

/** "Draft #482", or how far a branch without a pull request got: the chat card's chip, in words. */
export function lead(state: ChangeState): string {
  if (state.number !== null) return `${state.label} #${state.number}`;
  return state.noPullRequest && state.tone === "pushed"
    ? `${state.label}, no pull request`
    : state.label;
}

const checks = (count: number, verb: string) =>
  `${count} ${count === 1 ? "check" : "checks"} ${verb}`;

/**
 * "Draft #482 · 4 findings · 2 checks running · 3 uncommitted", as board B
 * words it, or "Pushed, no pull request · scott/branch" before a pull request;
 * a conflict with the base comes before any check, as in the chips.
 */
export function stripParts(summary: ChangeSummary, countUncommitted: boolean): Part[] {
  const pr = summary.pullRequest;
  const counts = pr?.state === "open" ? pr.checks : null;
  const parts: Part[] = [
    { text: lead(changeState(summary)), tone: "font-semibold text-foreground" },
  ];
  // Without a pull request number, the branch is what names the Change.
  if (!pr && summary.branch)
    parts.push({ text: summary.branch.name, tone: "text-muted-foreground", icon: "GitBranch" });
  if (summary.findings > 0)
    parts.push({ text: `${summary.findings} findings`, tone: "text-muted-foreground" });
  if (pr && conflictsWithBase(pr))
    parts.push({ text: `Conflicts with ${pr.baseRef}`, tone: "text-destructive-text" });
  if (counts && counts.failed > 0)
    parts.push({ text: checks(counts.failed, "failed"), tone: "text-destructive-text" });
  if (counts && counts.pending > 0)
    parts.push({ text: checks(counts.pending, "running"), tone: "text-warning" });
  if (countUncommitted && summary.uncommitted > 0)
    parts.push({
      text: `${summary.uncommitted} uncommitted`,
      tone: "text-(--tertiary-foreground)",
    });
  return parts;
}

export function StripSummary({
  threadId,
  environment,
  segments,
}: ExperimentalThreadContextSegmentProps) {
  const summary = stripSummary(useThreadChange(threadId, environment !== null));
  if (!summary) return null;
  const countUncommitted = !segments.some((segment) => segment.key === CHANGED_FILES_SEGMENT);
  const chips = attentionChips(summary);
  return (
    <span
      data-bb-plugin="source-control"
      data-testid="sc-strip"
      className="flex min-h-6 min-w-0 items-center gap-2 overflow-hidden px-2 py-1 text-[12px] leading-4 whitespace-nowrap"
      title={chips.map((chip) => chip.label).join(" · ") || undefined}
    >
      {stripParts(summary, countUncommitted).map((part, index) => (
        <span
          key={part.text}
          className={cx(
            part.tone,
            index > 0 && "min-w-0 truncate",
            part.icon && "flex items-center gap-1",
          )}
          data-promptbox-hide-compact={index > 1 ? "" : undefined}
        >
          {part.icon ? (
            <>
              <Icon name={part.icon} className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{part.text}</span>
            </>
          ) : (
            part.text
          )}
        </span>
      ))}
    </span>
  );
}

export function StripAction({ threadId, environment }: ExperimentalThreadContextSegmentProps) {
  const row = useThreadChange(threadId, environment !== null);
  const summary = stripSummary(row);
  if (!summary || row?.state !== "checkout") return null;
  const kind = primaryAction(summary)?.kind;
  if (kind === "ship") return <StripShip threadId={threadId} />;
  if (kind === "markReady") return <StripMarkReady threadId={threadId} summary={summary} />;
  return null;
}

/** A message beside a strip button: what it came to, in warning tone when it did not work. */
function StripMessage({ text, failed = true }: { text: string | null; failed?: boolean }) {
  return text ? (
    <output
      className={cx(
        "max-w-60 truncate text-[12px] leading-4",
        failed ? "text-warning" : "text-muted-foreground",
      )}
      title={text}
    >
      {text}
    </output>
  ) : null;
}

/** The `shipThread` call behind the strip's Ship it, and what it came to. */
function useStripShip(threadId: string) {
  const ship = useRpcMutation({ contract: sourceControlContract, method: "shipThread" });
  const [sent, setSent] = useState<{ text: string; failed: boolean } | null>(null);
  const send = async () => {
    setSent(null);
    try {
      const result = await ship.mutate({ threadId });
      setSent(
        result.ok
          ? { text: "Asked the agent to ship it.", failed: false }
          : { text: result.message, failed: true },
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "The request failed.";
      setSent({ text, failed: true });
    }
  };
  return { send, pending: ship.isPending, sent };
}

/**
 * Ship it: one message asking the thread's agent to commit and publish its
 * work with the repository's workflow, as the thread card's Ship it does.
 */
function StripShip({ threadId }: { threadId: string }) {
  const ship = useStripShip(threadId);
  return (
    <span data-bb-plugin="source-control" className="ml-auto flex shrink-0 items-center gap-2">
      <StripMessage text={ship.sent?.text ?? null} failed={ship.sent?.failed} />
      <Button
        variant="outline"
        data-testid="sc-strip-ship"
        onClick={() => void ship.send()}
        disabled={ship.pending}
        className="h-6 px-3 font-semibold"
      >
        <Pending pending={ship.pending} icon="Sent" />
        Ship it
      </Button>
    </span>
  );
}

function StripMarkReady({ threadId, summary }: { threadId: string; summary: ChangeSummary }) {
  const draft = useDraftToggle(threadId, summary.pullRequest ?? null);
  if (!draft.toggle) return null;
  return (
    <span data-bb-plugin="source-control" className="ml-auto flex shrink-0 items-center gap-2">
      <StripMessage text={draft.message} />
      <Button
        variant="outline"
        data-testid="sc-strip-mark-ready"
        onClick={draft.toggle}
        disabled={draft.pending}
        className="h-6 px-3 font-semibold"
      >
        <Pending pending={draft.pending} />
        Mark ready
      </Button>
    </span>
  );
}
