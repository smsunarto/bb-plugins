import { useRef, useState } from "react";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { prRefSchema, sameRef, type PullRequest } from "../shared/schema.ts";
import { prActionIssue, type PrAction, type MergeMethod } from "../shared/pr-actions.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

const LABEL: Record<PrAction, string> = {
  close: "Close PR",
  reopen: "Reopen PR",
  draft: "Mark as draft",
  ready: "Mark ready for review",
  merge: "Merge PR",
};
const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

function actionsFor(pr: PullRequest): PrAction[] {
  if (pr.state === "merged") return [];
  if (pr.state === "closed") return ["reopen"];
  if (pr.isDraft) return ["ready", "close"];
  return ["draft", "close", "merge"];
}

/** A confirmation captures the displayed head and acting account. */
export function PrActions({ pr }: { pr: PullRequest }) {
  const [confirm, setConfirm] = useState<{
    action: PrAction;
    headRefOid: string;
    baseRefName: string;
  } | null>(null);
  const controls = useRef<HTMLDivElement>(null);
  return (
    <div ref={controls} tabIndex={-1} className="flex min-w-0 flex-wrap gap-1 outline-none">
      {actionsFor(pr).map((action) => (
        <Button
          key={action}
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            setConfirm({ action, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName })
          }
        >
          {LABEL[action]}
        </Button>
      ))}
      {confirm ? (
        <PrActionDialog
          pr={pr}
          {...confirm}
          onClose={() => setConfirm(null)}
          onReturnFocus={() => controls.current?.focus()}
        />
      ) : null}
    </div>
  );
}

function refreshPr(pr: Pick<PullRequest, "ref">) {
  void pluginQueryClient.invalidateQueries({ queryKey: rpc.inbox.queryKey() });
  for (const method of ["pullRequest", "checks", "prActionState"]) {
    void pluginQueryClient.invalidateQueries({
      queryKey: [method],
      predicate: (query) => {
        const input = query.queryKey[1];
        const parsed = prRefSchema.safeParse(
          typeof input === "object" && input !== null && "ref" in input ? input.ref : null,
        );
        return parsed.success && sameRef(parsed.data, pr.ref);
      },
    });
  }
}

function PrActionDialog({
  pr,
  action,
  headRefOid,
  baseRefName,
  onClose,
  onReturnFocus,
}: {
  pr: PullRequest;
  action: PrAction;
  headRefOid: string;
  baseRefName: string;
  onClose: () => void;
  onReturnFocus: () => void;
}) {
  const [chosenMethod, setMethod] = useState<MergeMethod>("squash");
  const policy = rpc.prActionState.useQuery(
    { account: pr.account, ref: pr.ref },
    {
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: (query) => (query.state.data?.mergeStateStatus === "UNKNOWN" ? 2000 : false),
    },
  );
  const mutation = rpc.prAction.useMutation({
    onSettled: (_data, _error, variables) => refreshPr(variables),
  });
  const method = policy.data?.methods.includes(chosenMethod)
    ? chosenMethod
    : (policy.data?.methods[0] ?? chosenMethod);
  const issue = policy.data
    ? prActionIssue({ policy: policy.data, action, headRefOid, baseRefName, method })
    : "Checking permissions and merge requirements…";
  const canConfirm = !mutation.isPending && !policy.isFetching && !policy.isError && !issue;
  const close = () => {
    if (!mutation.isPending) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{LABEL[action]}</DialogTitle>
          <DialogDescription>
            {pr.ref.owner}/{pr.ref.repo}#{pr.ref.number}: {pr.title}. Acting as {pr.account}.
            Destination: {baseRefName}.
          </DialogDescription>
        </DialogHeader>
        {action === "merge" ? (
          <label className="flex flex-col gap-2 text-xs">
            Merge method
            <select
              aria-label="Merge method"
              className="rounded-md border border-border bg-background p-2 text-foreground"
              value={method}
              disabled={mutation.isPending}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "merge" || value === "squash" || value === "rebase") setMethod(value);
              }}
            >
              {policy.data?.methods.map((value) => (
                <option key={value} value={value}>
                  {METHOD_LABEL[value]}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">
              Merges directly. Use GitHub for repositories requiring a merge queue.
            </span>
          </label>
        ) : null}
        {pr.pendingReview && pr.pendingReview.draftCount > 0 ? (
          <p className="text-xs text-warning-text">
            You have {pr.pendingReview.draftCount} unsent draft comments. This action does not
            submit them.
          </p>
        ) : null}
        {policy.isError ? (
          <p role="alert" className="text-xs text-destructive-text">
            {errorText(policy.error)}
          </p>
        ) : issue ? (
          <output className="text-xs text-muted-foreground">{issue}</output>
        ) : null}
        {mutation.isError ? (
          <p role="alert" className="text-xs text-destructive-text">
            {errorText(mutation.error)} Refreshing the pull request to check its current state.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={mutation.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={() =>
              mutation.mutate(
                { account: pr.account, ref: pr.ref, action, headRefOid, baseRefName, method },
                { onSuccess: onClose },
              )
            }
          >
            {mutation.isPending ? "Updating…" : LABEL[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
