/**
 * Merge a pull request: today's merge dialog from code-review
 * (`plugins/code-review/src/app/pr-actions.tsx`), as a modal shadcn Dialog.
 * It reads the merge policy fresh when it opens, and again every two seconds
 * while GitHub is still computing the merge state. The merge is pinned to the
 * head and base the reader saw when they opened it, and never retried.
 */
import { experimental_useRpcMutation as useRpcMutation, useRpc } from "@get-bb/plugin-sdk/app";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { describeProblem, type ForgeResult, type Problem } from "../core/change.ts";
import type { ChangeKey } from "../core/ids.ts";
import { parseChangeKey, type ChangeDetail } from "../core/review.ts";
import {
  initialMethod,
  MERGE_METHOD_LABEL,
  mergeIssue,
  mergeMethodSchema,
  type MergeMethod,
  type MergePolicy,
} from "../core/merge.ts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Pending } from "./ui.tsx";

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

const UNKNOWN_POLL_MS = 2_000;

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

type PolicyRead =
  | { state: "loading" }
  | { state: "ready"; policy: MergePolicy }
  | { state: "failed"; message: string };

function problemText(problem: Problem): string {
  return "detail" in problem ? problem.detail : describeProblem(problem);
}

/** The merge policy, read when the dialog opens and while GitHub's merge state is UNKNOWN. */
function useMergePolicy(changeKey: ChangeKey, number: number, attempt: number): PolicyRead {
  const rpc = useRpc<typeof sourceControlContract>();
  // Each attempt is a new request; its answer is kept with it, so an older one reads as loading.
  const request = useMemo(() => ({ changeKey, number, attempt }), [changeKey, number, attempt]);
  const [answer, setAnswer] = useState<{ request: typeof request; read: PolicyRead } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (read: PolicyRead) => {
      if (live) setAnswer({ request, read });
    };
    const load = async () => {
      try {
        const result = await rpc.call("mergePolicy", {
          key: request.changeKey,
          number: request.number,
        });
        if (!result.ok) return settle({ state: "failed", message: problemText(result.problem) });
        settle({ state: "ready", policy: result.policy });
        if (live && result.policy.mergeStateStatus === "UNKNOWN")
          timer = setTimeout(load, UNKNOWN_POLL_MS);
      } catch (error) {
        settle({
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, request]);
  return answer && answer.request === request ? answer.read : { state: "loading" };
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
        ref={trigger}
        variant={variant}
        className={className}
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

/** The confirm step: merges once, closes when done or already merged, else says why and reads again. */
function useConfirmMerge(target: MergeTarget, submit: SubmitMerge, onClose: () => void) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const confirm = async (method: MergeMethod) => {
    setPending(true);
    setOutcome(null);
    let text: string | null;
    try {
      const result = await submit(target, method);
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
    // Whatever happened, the requirements are read again before another try.
    setAttempt((n) => n + 1);
  };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { pending, outcome, attempt, confirm, retry };
}

function MethodSelect({
  methods,
  method,
  disabled,
  onChange,
}: {
  methods: readonly MergeMethod[];
  method: MergeMethod;
  disabled: boolean;
  onChange: (method: MergeMethod) => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-[12px] leading-4">
      <span>Merge method</span>
      <Select
        value={method}
        disabled={disabled}
        onValueChange={(next) => {
          const value = mergeMethodSchema.safeParse(next);
          if (value.success) onChange(value.data);
        }}
      >
        <SelectTrigger
          aria-label="Merge method"
          data-testid="sc-merge-method"
          className="h-8 w-full border-border bg-background"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {methods.map((value) => (
            <SelectItem key={value} value={value}>
              {MERGE_METHOD_LABEL[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">
        Merges directly. Use GitHub for repositories requiring a merge queue.
      </span>
    </div>
  );
}

/** Why Merge is off: the policy cannot be read, or a requirement is unmet. */
function PolicyNote({
  read,
  issue,
  onRetry,
}: {
  read: PolicyRead;
  issue: string | null;
  onRetry: () => void;
}) {
  if (read.state === "failed")
    return (
      <p role="alert" className="m-0 text-[12px] leading-4 text-destructive-text">
        {read.message}{" "}
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 text-[12px] text-foreground underline"
          onClick={onRetry}
        >
          Try again
        </button>
      </p>
    );
  if (!issue) return null;
  return (
    <output data-testid="sc-merge-issue" className="text-[12px] leading-4 text-muted-foreground">
      {issue}
    </output>
  );
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
  const [chosen, setChosen] = useState<MergeMethod>("squash");
  const merge = useConfirmMerge(target, submit, onClose);
  const read = useMergePolicy(target.changeKey, target.number, merge.attempt);
  const policy = read.state === "ready" ? read.policy : null;
  const method = policy ? initialMethod(policy.methods, chosen) : chosen;
  let issue: string | null = null;
  if (policy) issue = mergeIssue({ policy, head: target.head, base: target.base, method });
  else if (read.state === "loading") issue = "Checking permissions and merge requirements…";
  const canConfirm = !merge.pending && policy !== null && !issue;
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
        showCloseButton={false}
        data-testid="sc-merge-dialog"
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader className="pr-0">
          <DialogTitle>Merge pull request</DialogTitle>
          <DialogDescription>
            {target.repo}#{target.number}: {target.title}. Destination: {target.base}.
          </DialogDescription>
        </DialogHeader>
        <MethodSelect
          methods={policy?.methods ?? [method]}
          method={method}
          disabled={merge.pending || !policy}
          onChange={setChosen}
        />
        <PolicyNote read={read} issue={issue} onRetry={merge.retry} />
        {merge.outcome ? (
          <p role="alert" className="m-0 text-[12px] leading-4 text-destructive-text">
            {merge.outcome}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={merge.pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="default"
            data-testid="sc-merge-confirm"
            disabled={!canConfirm}
            onClick={() => void merge.confirm(method)}
            className={cx(merge.pending && "cursor-progress")}
          >
            <Pending pending={merge.pending} />
            {merge.pending ? "Merging…" : MERGE_METHOD_LABEL[method]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
