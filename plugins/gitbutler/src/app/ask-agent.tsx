import { useCallback } from "react";
import { experimental_Icon as Icon, useComposer } from "@get-bb/plugin-sdk/app";
import { useBoardRepository } from "./board-context.tsx";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";
import { cn } from "./lib/utils.ts";

/**
 * Quotes `text` into the thread's composer, which also focuses it, so the
 * reader can ask the agent about a commit, file, or branch. The panel never
 * rewrites history itself, so this is also how a reader asks for that.
 *
 * In an environment of several repositories, the quote names the one on
 * screen: two of them can share a branch name, and the agent may be working
 * in the other.
 *
 * Null when the composer is not a thread's. Outside a thread the SDK writes
 * to the new-thread draft, whose agent is not the one in this workspace.
 */
export function useAskAgent(): ((text: string) => void) | null {
  const composer = useComposer();
  const repository = useBoardRepository();
  const ask = useCallback(
    (text: string) => composer.addQuote(repository ? `${text}\n\nRepository: ${repository}` : text),
    [composer, repository],
  );
  return composer.scope.kind === "new-thread" ? null : ask;
}

/** An icon button that quotes `text` to the agent. Hidden when there is no thread to ask. */
export function AskAgentButton({
  text,
  label,
  className,
}: {
  text: string;
  /** The accessible name, which says what is asked about: "Ask agent about scott/top". */
  label: string;
  className?: string;
}) {
  const ask = useAskAgent();
  if (!ask) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground",
        CONTROL_HOVER_TRANSITION,
        className,
      )}
      onClick={(event) => {
        // Like Copy, it sits inside rows that open or expand on click.
        event.stopPropagation();
        ask(text);
      }}
    >
      <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
    </button>
  );
}
