/**
 * Merge a pull request: a modal shadcn Dialog that squashes on confirm. It
 * reads nothing first and closes at once; the server checks GitHub's
 * requirements as it merges, and bb's toast follows the merge to its end and
 * says why GitHub refused it. The merge is pinned to the head and base the
 * reader saw when they opened it, and runs again only when the reader asks.
 */
import {
  experimental_PluginRpcCallError as PluginRpcCallError,
  experimental_useRpcMutation as useRpcMutation,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { describeProblem, type ForgeResult } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { parseChangeKey, type ChangeDetail } from "../core/review.ts";
import type { MergeMethod } from "../core/merge.ts";
import { sourceControlContract } from "../contract/rpc.ts";
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

/**
 * Merges in this window, by pull request (`owner/name#number`), whichever
 * surface started them. A merge stays `merging` until the server answers and
 * `merged` after, so Merge stays off until the pull request's read says so.
 * A merge outlives the surface that started it: the request is the server's
 * once sent, and the toast here follows it.
 */
type Run = { phase: "merging"; id: number } | { phase: "merged" };
export type MergePhase = "idle" | Run["phase"];

const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
let lastRun = 0;

function setRun(key: string, run: Run | null) {
  if (run) runs.set(key, run);
  else runs.delete(key);
  for (const listener of listeners) listener();
}

/** A pull request as the run store names it: `owner/name` and its number. */
type PullRequestRef = Pick<MergeTarget, "repo" | "number">;

function runKey(target: PullRequestRef): string {
  return `${target.repo}#${target.number}`;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Where a merge of `pullRequest` stands in this window; idle for none. */
export function useMergePhase(pullRequest: PullRequestRef | null): MergePhase {
  const key = pullRequest ? runKey(pullRequest) : null;
  return useSyncExternalStore(subscribe, () => (key ? runs.get(key)?.phase : null) ?? "idle");
}

/** For tests: forget every merge this window ran. */
export function resetMergeRuns() {
  runs.clear();
  for (const listener of listeners) listener();
}

/** Past this, the toast stops spinning and says the outcome is unknown; a later answer still lands. */
export const MERGE_DEADLINE_MS = 120_000;

/** Why a merge did not happen, and what the reader can do about it. */
type Refusal = { reason: string; next: "retry" | "github" };

/** GitHub refused it for the pull request's own state: Retry would only be refused again. */
function refusalOf(result: ForgeResult): Refusal | null {
  switch (result.status) {
    case "done":
    case "upToDate":
      return null;
    case "conflict":
      return { reason: result.detail, next: "github" };
    case "failed":
      if (result.problem.kind === "failed")
        return { reason: plain(result.problem.detail), next: "github" };
      // describeProblem speaks of reads, which bb retries itself; a merge waits for the reader.
      if (result.problem.kind === "rate-limited")
        return {
          reason: `GitHub is rate-limiting ${result.problem.site}. Try again in a few minutes.`,
          next: "retry",
        };
      return { reason: describeProblem(result.problem), next: "retry" };
  }
}

/** GitHub's reason without the status code `gh` appends, such as "(HTTP 405)". */
function plain(detail: string): string {
  return detail.replace(/\s*\(HTTP \d{3}\)\s*$/, "");
}

function thrownRefusal(error: unknown): Refusal {
  if (error instanceof PluginRpcCallError && error.code === "transport_error")
    return {
      reason: "bb could not reach its server, so the merge may not have started.",
      next: "retry",
    };
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return { reason: `The bb server could not run the merge.${detail}`, next: "retry" };
}

const UNANSWERED: Refusal = {
  reason: "bb has not heard back. It may still merge; check the pull request on GitHub.",
  next: "github",
};

/** The pull request on GitHub; `repo` is `owner/name`. */
function gitHubUrl(target: MergeTarget): string {
  return `https://github.com/${target.repo}/pull/${target.number}`;
}

type MergeRun = { target: MergeTarget; submit: SubmitMerge; openUrl: (url: string) => void };

/**
 * Starts squash-merging `target` unless this window is already merging it or
 * has merged it; returns whether it started. One toast per pull request
 * follows it: Merging…, then Merged or the reason with Retry or Open on GitHub.
 */
export function startMerge(merge: MergeRun): boolean {
  const { target, submit } = merge;
  const key = runKey(target);
  if (runs.has(key)) return false;
  const run = { phase: "merging" as const, id: ++lastRun };
  setRun(key, run);
  const id = `sc-merge:${key}`;
  toast.loading(`Merging ${key}…`, { id });
  const current = () => runs.get(key) === run;
  const timer = setTimeout(() => {
    if (!current()) return;
    setRun(key, null);
    refused(merge, id, UNANSWERED);
  }, MERGE_DEADLINE_MS);
  void submit(target, "squash").then(
    (result) => settle(refusalOf(result)),
    (error: unknown) => settle(thrownRefusal(error)),
  );
  function settle(refusal: Refusal | null) {
    clearTimeout(timer);
    if (refusal === null) {
      // A late success still counts, even after the deadline or during a retry.
      setRun(key, { phase: "merged" });
      toast.success(`Merged #${target.number}`, { id, description: target.title });
      return;
    }
    if (!current()) return;
    setRun(key, null);
    refused(merge, id, refusal);
  }
  return true;
}

function refused(merge: MergeRun, id: string, refusal: Refusal) {
  const { target, openUrl } = merge;
  toast.error(`Couldn't merge #${target.number}`, {
    id,
    description: refusal.reason,
    duration: 12_000,
    action:
      refusal.next === "retry"
        ? { label: "Retry", onClick: () => void startMerge(merge) }
        : { label: "Open on GitHub", onClick: () => openUrl(gitHubUrl(target)) },
  });
}

/**
 * A button that opens the merge dialog for `target`, returning focus to
 * itself on close. While the merge runs it reads Merging… and stays
 * focusable but inert, so focus has somewhere to return to.
 */
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
  const navigate = useBbNavigate();
  const phase = useMergePhase(target);
  const busy = phase !== "idle";
  return (
    <>
      <Button
        size="sm"
        ref={trigger}
        variant={variant}
        className={cn("h-7", busy && "cursor-default opacity-70", className)}
        data-testid={testId}
        data-phase={phase}
        disabled={disabled}
        aria-disabled={busy || undefined}
        aria-busy={phase === "merging" || undefined}
        aria-label={`Merge #${target.number}`}
        // The dialog keeps the head and base seen now, whatever arrives while it is open.
        onClick={() => {
          if (!busy) setOpen(target);
        }}
      >
        <Pending pending={phase === "merging"} icon={phase === "merged" ? "Check" : "GitMerge"} />
        {phase === "merging" ? "Merging…" : phase === "merged" ? "Merged" : label}
      </Button>
      {open ? (
        <MergeDialog
          target={open}
          onConfirm={() =>
            startMerge({ target: open, submit, openUrl: (url) => void navigate.openUrl(url) })
          }
          onClose={() => setOpen(null)}
          returnFocus={() => trigger.current?.focus()}
        />
      ) : null}
    </>
  );
}

export function MergeDialog({
  target,
  onConfirm,
  onClose,
  returnFocus,
}: {
  target: MergeTarget;
  /** Starts the merge; the dialog closes as it does. */
  onConfirm: () => void;
  onClose: () => void;
  /** Where focus goes once the dialog is gone; Radix's trap would undo it any earlier. */
  returnFocus?: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
        <DialogFooter>
          <Button size="sm" className="h-7" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="default"
            data-testid="sc-merge-confirm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="h-7"
          >
            Squash and merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
