/**
 * The composer strip (board B): the thread's Change in one line above the
 * composer, with Mark ready while it is a draft. A thread context segment,
 * so it mounts only for threads that have a Change.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
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

type Part = { text: string; tone: string };

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
 * words it; a conflict with the base comes before any check, as in the chips.
 */
export function stripParts(summary: ChangeSummary, countUncommitted: boolean): Part[] {
  const pr = summary.pullRequest;
  const counts = pr?.state === "open" ? pr.checks : null;
  const parts: Part[] = [
    { text: lead(changeState(summary)), tone: "font-semibold text-foreground" },
  ];
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
          className={cx(part.tone, index > 0 && "min-w-0 truncate")}
          data-promptbox-hide-compact={index > 1 ? "" : undefined}
        >
          {part.text}
        </span>
      ))}
    </span>
  );
}

export function StripAction({ threadId, environment }: ExperimentalThreadContextSegmentProps) {
  const summary = stripSummary(useThreadChange(threadId, environment !== null));
  const pr = summary?.pullRequest ?? null;
  const draft = useDraftToggle(threadId, pr);
  if (!summary || primaryAction(summary)?.kind !== "markReady" || !draft.toggle) return null;
  return (
    <span data-bb-plugin="source-control" className="flex shrink-0 items-center gap-2">
      {draft.message ? (
        <output
          className="max-w-60 truncate text-[12px] leading-4 text-warning"
          title={draft.message}
        >
          {draft.message}
        </output>
      ) : null}
      <button
        type="button"
        data-testid="sc-strip-mark-ready"
        onClick={draft.toggle}
        disabled={draft.pending}
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-[6px] border border-solid border-border bg-transparent px-3 text-[12px] leading-4 font-semibold text-foreground transition-colors enabled:hover:bg-surface-raised disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none"
      >
        <Pending pending={draft.pending} />
        Mark ready
      </button>
    </span>
  );
}
