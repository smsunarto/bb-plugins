/**
 * Merge a pull request: a modal shadcn Dialog that squashes on confirm. It
 * reads nothing first; the server checks GitHub's requirements as it merges
 * and the dialog reports any it refuses. The merge is pinned to the head and
 * base the reader saw when they opened it, and never retried.
 */
import { experimental_useRpcMutation as useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { describeProblem, type ForgeResult, type Problem } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { parseChangeKey, type ChangeDetail } from "../core/review.ts";
import type { MergeMethod } from "../core/merge.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";
import { Button, type ButtonProps } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Pending } from "./ui.tsx";
import { cn } from "./lib/utils.ts";

/** The pull request as the reader saw it when they chose to merge. */
export type MergeTarget = {
  changeKey: ChangeKey;
  repo: string;
  number: number;
  title: string;
  head: string;
  base: string;
};

/** Merges `target` with `method`, pinned to the head and base it holds. */
export type SubmitMerge = (target: MergeTarget, method: MergeMethod) => Promise<ForgeResult>;

/** Merge through the thread's own pull request (the tab). */
export function useThreadMerge(threadId: string): SubmitMerge {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "forgeAction" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  return useCallback(
    (target, method) =>
      mutate.current({
        threadId,
        action: { kind: "merge", method, base: target.base },
        expected: { number: target.number, head: target.head },
      }),
    [threadId],
  );
}

/** Merge a Change's pull request by its key (the review page and chat cards). */
export function useChangeMerge(): SubmitMerge {
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "changeForgeAction" });
  const mutate = useRef(mutation.mutate);
  useLayoutEffect(() => {
    mutate.current = mutation.mutate;
  });
  return useCallback(
    (target, method) =>
      mutate.current({
        key: target.changeKey,
        action: { kind: "merge", method, base: target.base },
        expected: { number: target.number, head: target.head },
      }),
    [],
  );
}

/**
 * What Merge acts on for a Change's detail: its open pull request at the
 * head and base the reader sees; null for anything else.
 */
export function mergeTarget(
  detail: Extract<ChangeDetail, { state: "change" }>,
): MergeTarget | null {
  const { row, head } = detail;
  if (row.state !== "open" || row.number === null || head === null || !row.baseRef) return null;
  return {
    changeKey: row.key,
    repo: row.repo,
    number: row.number,
    title: row.title,
    head,
    base: row.baseRef,
  };
}

/**
 * Ready to merge, as the chat card offers it: an open pull request that is
 * committed, pushed and passing its checks, with no changes requested. An
 * approval GitHub requires is the dialog's to report, from GitHub's own
 * merge state, as code-review's card left it.
 */
export function readyToMerge(detail: Extract<ChangeDetail, { state: "change" }>): boolean {
  if (mergeTarget(detail) === null) return false;
  return detail.ship.every((step) => {
    if (step.id === "merged") return step.state !== "failed";
    if (step.id === "approval") return step.state !== "failed";
    return step.state === "done";
  });
}

/** `owner/name` of a GitHub Change, for the dialog's description. */
export function repoOfKey(key: ChangeKey): string {
  const parsed = parseChangeKey(key);
  return parsed?.kind === "gh" ? `${parsed.repo.owner}/${parsed.repo.name}` : "";
}

function problemText(problem: Problem): string {
  return "detail" in problem ? problem.detail : describeProblem(problem);
}

/** What the reader is told after a merge that did not simply happen. */
function resultText(result: ForgeResult): string | null {
  if (result.status === "conflict") return result.detail;
  if (result.status === "failed")
    return `${problemText(result.problem)} Refreshing the pull request to check its current state.`;
  return null;
}

/** A button that opens the merge dialog for `target`, returning focus to itself on close. */
export function MergeButton({
  target,
  submit,
  label = "Merge",
  variant = "outline",
  className,
  testId = "sc-merge",
  disabled,
}: {
  target: MergeTarget;
  submit: SubmitMerge;
  label?: ReactNode;
  variant?: ButtonProps["variant"];
  className?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<MergeTarget | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        size="sm"
        ref={trigger}
        variant={variant}
        className={cn("h-7", className)}
        data-testid={testId}
        disabled={disabled}
        aria-label={`Merge #${target.number}`}
        // The dialog keeps the head and base seen now, whatever arrives while it is open.
        onClick={() => setOpen(target)}
      >
        <Pending pending={false} icon="GitMerge" />
        {label}
      </Button>
      {open ? (
        <MergeDialog
          target={open}
          submit={submit}
          onClose={() => setOpen(null)}
          returnFocus={() => trigger.current?.focus()}
        />
      ) : null}
    </>
  );
}

/** The confirm step: squashes once, closes when done or already merged, else says why. */
function useConfirmMerge(target: MergeTarget, submit: SubmitMerge, onClose: () => void) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const confirm = async () => {
    setPending(true);
    setOutcome(null);
    let text: string | null;
    try {
      const result = await submit(target, "squash");
      text = resultText(result);
      if (result.status === "done" || result.status === "upToDate") {
        onClose();
        return;
      }
    } catch (error) {
      text = `${error instanceof Error ? error.message : "The request failed."} Refreshing the pull request to check its current state.`;
    }
    setPending(false);
    setOutcome(text);
  };
  return { pending, outcome, confirm };
}

export function MergeDialog({
  target,
  submit,
  onClose,
  returnFocus,
}: {
  target: MergeTarget;
  submit: SubmitMerge;
  onClose: () => void;
  /** Where focus goes once the dialog is gone; Radix's trap would undo it any earlier. */
  returnFocus?: () => void;
}) {
  const merge = useConfirmMerge(target, submit, onClose);
  const close = () => {
    if (!merge.pending) onClose();
  };
  return (
    // Escape or a click outside: a merge in flight keeps the dialog open.
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        hideCloseButton
        data-testid="sc-merge-dialog"
        {...(returnFocus ? { onAfterCloseAutoFocus: returnFocus } : {})}
      >
        <DialogHeader>
          <DialogTitle>Merge pull request</DialogTitle>
          <DialogDescription>
            {target.repo}#{target.number}: {target.title}. Destination: {target.base}.
          </DialogDescription>
        </DialogHeader>
        {merge.outcome ? (
          <p role="alert" className="m-0 text-[12px] leading-4 text-destructive-text">
            {merge.outcome}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            size="sm"
            className="h-7"
            variant="outline"
            disabled={merge.pending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="default"
            data-testid="sc-merge-confirm"
            disabled={merge.pending}
            onClick={() => void merge.confirm()}
            className={cx("h-7", merge.pending && "cursor-progress")}
          >
            <Pending pending={merge.pending} />
            {merge.pending ? "Merging…" : "Squash and merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
