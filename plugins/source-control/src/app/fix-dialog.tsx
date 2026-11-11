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
import { useEffect, useRef, useState } from "react";
import type { CheckRow } from "../core/change.ts";
import { checkId, checkNames } from "../core/fix-checks.ts";
import type { ChangeKey } from "../core/ids.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { cx } from "./format.ts";
import { Bar, Button } from "./ui.tsx";

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
        <Button onClick={() => void prompt.refetch()}>Try again</Button>
      </div>
    ) : (
      <output className="flex flex-col gap-2 text-[12px] leading-4" aria-busy="true">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon
            name="Spinner"
            fallback="Loader"
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Fetching the failing logs…
        </span>
        <Bar className="h-64 w-full" />
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

/** An open picker of the composer's (a menu, list or popover), which Escape closes first. */
const PICKER = "[data-radix-popper-content-wrapper], [role=menu], [role=listbox]";

/**
 * Escape closes the dialog, and only the dialog: bb leaves the page on an
 * Escape nothing claimed. One meant for an open picker is left to it.
 */
function useEscapeToClose(onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(PICKER)) return;
      event.preventDefault();
      close.current();
    };
    // Capture, so it runs before bb's own Escape.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/**
 * The dialog, opened on the checks the reader picked. Not a native modal
 * dialog: the composer's pickers open outside it, and a modal one would keep
 * them under it. Escape or Close closes it, and focus returns
 * to what opened it.
 */
export function FixDialog({ target, onClose }: { target: FixTarget; onClose: () => void }) {
  useEscapeToClose(onClose);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus();
  }, []);
  return (
    <div
      data-bb-plugin="source-control"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      {/* Open in place, not shown modal: see above. */}
      <dialog
        open
        aria-modal="true"
        aria-labelledby="sc-fix-title"
        data-testid="sc-fix-dialog"
        // Scrolls as a whole: bb caps the composer's editor against the viewport, not this dialog.
        className="static m-0 flex max-h-full w-[720px] max-w-full min-w-0 flex-col gap-3 overflow-y-auto rounded-[10px] border border-solid border-border bg-popover p-4 text-start text-foreground shadow-xl"
      >
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id="sc-fix-title" className="m-0 text-[15px] leading-5 font-semibold">
              Fix failing checks
            </h2>
            <p className="m-0 text-[12px] leading-4 break-words text-muted-foreground">
              The prompt carries the failing logs of {checkNames(target.checks)}. Review or edit it,
              then send it to start a thread.
            </p>
          </div>
          <Button variant="ghost" aria-label="Close" onClick={onClose}>
            <Icon name="X" className="size-3.5" aria-hidden />
          </Button>
        </div>
        <FixComposer target={target} onClose={onClose} />
      </dialog>
    </div>
  );
}
