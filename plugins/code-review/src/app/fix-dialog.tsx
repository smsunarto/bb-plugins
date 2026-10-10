import {
  experimental_Icon as Icon,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { toast } from "sonner";
import { prKey } from "../shared/schema.ts";
import type { Check, PullRequest } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { cn } from "./lib/utils.ts";
import { Notice, RetryButton, errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

/** Failing logs do not change once a check has failed, so the prompt keeps for a while. */
const PROMPT_STALE_MS = 5 * 60_000;

/**
 * Where the composer keeps an unsent fix. The composer only seeds an empty
 * draft, so a draft kept for other checks, or for an older push, would
 * otherwise hide the prompt for the checks failing now.
 */
export function fixDraftKey(
  pr: Pick<PullRequest, "ref" | "headRefOid">,
  checkIds: readonly string[],
) {
  return `code-review-fix:${prKey(pr.ref)}@${pr.headRefOid}:${checkIds.toSorted().join(",")}`;
}

/** `build`, `build and lint`, `build, lint, and 2 more`. */
export function checkNames(checks: readonly Pick<Check, "name">[]): string {
  const names = checks.map((check) => check.name);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/**
 * A new-thread composer, pre-filled with a prompt that carries the failing
 * checks' logs. Nothing runs until the reader sends it, so they can edit the
 * prompt and pick the project, agent, and environment first.
 */
export function FixDialog({
  pr,
  checks,
  open,
  onOpenChange,
}: {
  pr: PullRequest;
  checks: Check[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Scrolls as a whole: bb caps the composer's editor against the viewport,
          not this dialog, so a tall prompt must never push past the header. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col gap-3 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fix failing checks</DialogTitle>
          <DialogDescription className="text-xs">
            The prompt carries the failing logs of {checkNames(checks)}. Review or edit it, then
            send it to start a thread.
          </DialogDescription>
        </DialogHeader>
        {checks.length > 0 ? (
          <FixComposer pr={pr} checks={checks} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FixComposer({
  pr,
  checks,
  onClose,
}: {
  pr: PullRequest;
  checks: Check[];
  onClose: () => void;
}) {
  const navigate = useBbNavigate();
  const checkIds = checks.map((check) => check.id);
  const prompt = rpc.fixChecksPrompt.useQuery(
    { ref: pr.ref, checkIds },
    { staleTime: PROMPT_STALE_MS, refetchOnWindowFocus: false },
  );
  const start = rpc.startFix.useMutation();

  if (prompt.isPending) {
    return (
      <output className="flex flex-col gap-2.5 text-xs" aria-busy>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon name="Loading" className="size-3 motion-safe:animate-spin" aria-hidden />
          Fetching the failing logs…
        </span>
        <Skeleton className="h-64 w-full rounded-lg" />
      </output>
    );
  }
  if (prompt.isError) {
    return (
      <Notice
        tone="error"
        title="Could not prepare the fix"
        action={<RetryButton onRetry={() => void prompt.refetch()} />}
      >
        {errorText(prompt.error)}
      </Notice>
    );
  }

  const { prompt: text, projectId, environment } = prompt.data;

  // bb before the embeddable composer: hand the prompt to the main one.
  if (typeof NewThreadComposer !== "function" && typeof NewThreadComposer !== "object") {
    return (
      <>
        <pre className="max-h-[50vh] min-h-32 overflow-auto rounded-lg border border-border bg-card p-2.5 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
        </pre>
        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              onClose();
              navigate.toCompose({ initialPrompt: text, focusPrompt: true });
            }}
          >
            Continue in a new thread
          </Button>
        </DialogFooter>
      </>
    );
  }

  const submit = async (request: NewThreadRequest) => {
    try {
      const { threadId } = await start.mutateAsync({
        ref: pr.ref,
        headRefOid: pr.headRefOid,
        request: { ...request },
      });
      void pluginQueryClient.invalidateQueries({
        queryKey: rpc.agentActivity.queryKey({ ref: pr.ref }),
      });
      onClose();
      navigate.toThread(threadId);
    } catch (error) {
      toast.error(errorText(error));
      // Rethrown so the composer keeps the draft.
      throw error;
    }
  };

  return (
    // Natural height: the composer sizes its own editor, and a fixed box
    // shorter than that editor let the prompt spill over the dialog header.
    <div
      aria-busy={start.isPending}
      className={cn("min-h-0 shrink-0", start.isPending && "pointer-events-none opacity-70")}
    >
      <NewThreadComposer
        {...(projectId ? { defaultProjectId: projectId } : {})}
        {...(environment ? { defaultEnvironment: environment } : {})}
        initialPrompt={text}
        draftKey={fixDraftKey(pr, checkIds)}
        layout="contained"
        focusRequest={1}
        onSubmit={submit}
      />
    </div>
  );
}
