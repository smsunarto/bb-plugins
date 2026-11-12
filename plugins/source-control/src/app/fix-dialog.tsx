/**
 * Fix checks: a new-thread composer, pre-filled with a prompt that carries
 * the failing checks' logs. Nothing runs until the reader sends it, so they
 * can edit the prompt and pick the project, agent and environment first.
 * Ported from code-review (`src/app/fix-dialog.tsx`).
 */
import {
  experimental_Icon as Icon,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type { CheckRow } from "../core/change.ts";
import { checkId, checkNames } from "../core/fix-checks.ts";
import type { ChangeKey } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { cx } from "./format.ts";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";

export type FixTarget = { changeKey: ChangeKey; head: string; checks: CheckRow[] };

/**
 * Where the composer keeps an unsent fix. The composer only seeds an empty
 * draft, so a draft kept for other checks, or for an older push, would
 * otherwise hide the prompt for the checks failing now.
 */
export function fixDraftKey(target: FixTarget) {
  const ids = target.checks.map(checkId).toSorted().join(",");
  return `source-control-fix:${target.changeKey}@${target.head}:${ids}`;
}

function FixComposer({ target, onClose }: { target: FixTarget; onClose: () => void }) {
  const navigate = useBbNavigate();
  const prompt = useRpcQuery({
    contract: sourceControlContract,
    method: "fixChecksPrompt",
    input: { key: target.changeKey, head: target.head, checks: target.checks.map(checkId) },
  });
  const start = useRpcMutation({ contract: sourceControlContract, method: "startFix" });
  const [failure, setFailure] = useState<string | null>(null);
  const answer = prompt.data;
  if (!answer)
    return prompt.error ? (
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="alert">
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-destructive-text">
          Could not prepare the fix. {prompt.error.message}
        </p>
        <Button variant="outline" onClick={() => void prompt.refetch()}>
          Try again
        </Button>
      </div>
    ) : (
      <output className="flex flex-col gap-2 text-[12px] leading-4" aria-busy="true">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon
            name="Spinner"
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Fetching the failing logs…
        </span>
        <Skeleton className="h-64 w-full" />
      </output>
    );
  if (!answer.ok)
    return (
      <p role="alert" className="m-0 text-[12px] leading-4 text-destructive-text">
        {answer.message}
      </p>
    );
  const submit = async (request: NewThreadRequest) => {
    setFailure(null);
    let result;
    try {
      result = await start.mutate({
        key: target.changeKey,
        head: target.head,
        request: { ...request },
      });
    } catch (error) {
      result = {
        ok: false as const,
        message: error instanceof Error ? error.message : "The thread did not start.",
      };
    }
    if (!result.ok) {
      setFailure(result.message);
      // Thrown so the composer keeps the draft.
      throw new Error(result.message);
    }
    onClose();
    navigate.toThread(result.threadId);
  };
  return (
    // Natural height: the composer sizes its own editor.
    <div
      aria-busy={start.isPending}
      className={cx("flex min-h-0 shrink-0 flex-col gap-2", start.isPending && "opacity-70")}
    >
      {failure ? (
        <p role="alert" className="m-0 text-[12px] leading-4 text-destructive-text">
          {failure}
        </p>
      ) : null}
      <NewThreadComposer
        {...(answer.projectId ? { defaultProjectId: answer.projectId } : {})}
        {...(answer.environment ? { defaultEnvironment: answer.environment } : {})}
        initialPrompt={answer.prompt}
        draftKey={fixDraftKey(target)}
        layout="contained"
        focusRequest={1}
        onSubmit={submit}
      />
    </div>
  );
}

/**
 * The dialog, opened on the checks the reader picked. Not modal: the
 * composer's pickers open outside it, and a modal one would keep them under
 * it. Escape or Close closes it, and focus returns to what opened it.
 */
export function FixDialog({ target, onClose }: { target: FixTarget; onClose: () => void }) {
  return (
    <Dialog
      modal={false}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-modal="true"
        data-testid="sc-fix-dialog"
        // The composer takes focus itself once its prompt is ready.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Scrolls as a whole: bb caps the composer's editor against the viewport, not this dialog.
        className="w-[720px]"
      >
        <DialogHeader>
          <DialogTitle>Fix failing checks</DialogTitle>
          <DialogDescription>
            The prompt carries the failing logs of {checkNames(target.checks)}. Review or edit it,
            then send it to start a thread.
          </DialogDescription>
        </DialogHeader>
        <FixComposer target={target} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
