/**
 * The Change's status as boards A and B draw it: the ship path, the
 * attention chips, and the draft toggle. Every value comes from
 * `core/status.ts`, so the tab header, the composer strip and other
 * plugins' rows say the same thing.
 */
import { experimental_useRpcMutation as useRpcMutation } from "@get-bb/plugin-sdk/app";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ForgeResult, PullRequest } from "../core/change.ts";
import type { AttentionChip, ShipStep } from "../core/status.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";

// ── Ship path (board A, "Ship path") ───────────────────────────────────

function StepIcon({ state }: { state: ShipStep["state"] }) {
  const common = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true } as const;
  switch (state) {
    case "done":
      return (
        <svg {...common} className="shrink-0">
          <circle cx="7" cy="7" r="6" fill="var(--success)" />
          <path
            d="M4.5 7.2L6.2 8.9L9.5 5.4"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "current":
      return (
        <svg {...common} className="shrink-0">
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="var(--primary)" strokeWidth="1.5" />
          <circle cx="7" cy="7" r="2.5" fill="var(--primary)" />
        </svg>
      );
    case "running":
      return (
        <svg {...common} className="shrink-0">
          <circle
            cx="7"
            cy="7"
            r="5.25"
            fill="none"
            stroke="var(--warning)"
            strokeWidth="1.5"
            strokeDasharray="3 2.5"
          />
        </svg>
      );
    case "failed":
      return (
        <svg {...common} className="shrink-0">
          <circle
            cx="7"
            cy="7"
            r="5.25"
            fill="none"
            stroke="var(--destructive)"
            strokeWidth="1.5"
          />
          <path
            d="M5 5L9 9M9 5L5 9"
            fill="none"
            stroke="var(--destructive)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <svg {...common} className="shrink-0">
          <circle
            cx="7"
            cy="7"
            r="5.25"
            fill="none"
            stroke="color-mix(in oklab, var(--tertiary-foreground) 50%, transparent)"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
}

const LABEL_TONE: Record<ShipStep["state"], string> = {
  done: "text-muted-foreground",
  current: "font-semibold text-foreground",
  running: "text-muted-foreground",
  failed: "text-muted-foreground",
  todo: "text-(--tertiary-foreground)",
};
const DETAIL_TONE = {
  warning: "text-warning",
  error: "text-destructive-text",
  muted: "text-(--tertiary-foreground)",
} as const;

/**
 * Committed → Merged; a connector is green after a finished step. Every
 * width keeps the connectors; narrower than one line holds, the steps wrap
 * and a continued line starts with one.
 */
export const ShipPath = memo(function ShipPath({ steps }: { steps: readonly ShipStep[] }) {
  return (
    <ol
      data-testid="sc-ship-path"
      aria-label="Ship path"
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-3 gap-y-1.5 p-0 text-[12px] leading-4 @4xl:gap-x-2"
    >
      {steps.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2" data-state={step.state}>
          {index > 0 ? (
            <span
              aria-hidden
              className={cx(
                "block h-px w-4 shrink-0 @4xl:w-7",
                steps[index - 1]!.state === "done" ? "bg-success" : "bg-border",
              )}
            />
          ) : null}
          <StepIcon state={step.state} />
          <span className={LABEL_TONE[step.state]}>{step.label}</span>
          {step.detail.map((part) => (
            <span key={part.text} className={DETAIL_TONE[part.tone]}>
              {part.text}
            </span>
          ))}
        </li>
      ))}
    </ol>
  );
});

// ── Attention chips (board A list rows) ────────────────────────────────

const CHIP_TEXT: Record<AttentionChip["tone"], string> = {
  neutral: "text-foreground",
  warning: "text-warning",
  error: "text-destructive-text",
  success: "text-success-foreground",
  merged: "text-(--pr-merged)",
};

function ChipIcon({ chip }: { chip: AttentionChip }) {
  if (chip.icon === "dot")
    return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />;
  if (chip.icon === "cross")
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        <path
          d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
          fill="none"
          stroke="var(--destructive)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  if (chip.icon === "check")
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        <path
          d="M2 5.5L4 7.5L8 3"
          fill="none"
          stroke="var(--success)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return null;
}

export const Chips = memo(function Chips({ chips }: { chips: readonly AttentionChip[] }) {
  if (chips.length === 0) return null;
  return (
    <ul
      data-testid="sc-chips"
      aria-label="Needs attention"
      className="m-0 flex min-w-0 list-none flex-wrap items-center gap-2 p-0"
    >
      {chips.map((chip) => (
        <li
          key={chip.id}
          className={cx(
            // A chip that fits on no line by itself shortens its label; one that does not fit after others wraps out of a one-line row whole.
            "flex h-5 max-w-full min-w-0 items-center gap-1 rounded-full border border-solid px-2",
            chip.tone === "error"
              ? "border-[color-mix(in_oklab,var(--destructive)_40%,transparent)]"
              : "border-border",
          )}
        >
          <ChipIcon chip={chip} />
          <span
            className={cx(
              "min-w-0 truncate text-[11px] leading-4 font-medium",
              CHIP_TEXT[chip.tone],
            )}
          >
            {chip.label}
          </span>
        </li>
      ))}
    </ul>
  );
});

// ── Draft toggle ───────────────────────────────────────────────────────

export type DraftOutcome = { head: string; result: ForgeResult } | null;

/** What the reader is told after Mark ready or Convert to draft did not simply happen. */
export function draftOutcomeText(outcome: DraftOutcome, pr: PullRequest | null): string | null {
  if (!outcome || !pr || outcome.head !== pr.headRefOid) return null;
  const { result } = outcome;
  if (result.status === "conflict") return result.detail;
  if (result.status === "failed")
    return "detail" in result.problem ? result.problem.detail : "GitHub did not take the change.";
  return null;
}

/**
 * Mark ready or Convert to draft for the thread's pull request, at the head
 * the reader sees. The answer is kept per head, so it clears once GitHub's
 * new state arrives.
 */
export function useDraftToggle(threadId: string, pr: PullRequest | null) {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "forgeAction" });
  const [outcome, setOutcome] = useState<DraftOutcome>(null);
  const pending = mutation.pendingInputs.some((input) => input.threadId === threadId);
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  const toggle = useMemo(
    () =>
      pr && pr.state === "open"
        ? () => {
            const head = pr.headRefOid;
            setOutcome(null);
            mutate
              .current({
                threadId,
                action: { kind: "setDraft", draft: !pr.isDraft },
                expected: { number: pr.number, head },
              })
              .then(
                (result) => setOutcome({ head, result }),
                (error: unknown) =>
                  setOutcome({
                    head,
                    result: {
                      status: "failed",
                      problem: {
                        kind: "failed",
                        site: "GitHub",
                        detail: error instanceof Error ? error.message : "The request failed.",
                      },
                    },
                  }),
              );
          }
        : null,
    [pr, threadId],
  );
  return { toggle, pending, message: draftOutcomeText(outcome, pr) };
}
