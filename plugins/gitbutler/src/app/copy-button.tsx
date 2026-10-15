import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils.ts";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";

const COPIED_FEEDBACK_MS = 1_200;

/**
 * An icon button that copies `value` and turns into a check for a moment.
 * The check is also said aloud: an icon swap alone tells a screen reader
 * nothing. A clipboard the browser refuses shows a warning and says why.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** The accessible name, which says what is copied: "Copy commit SHA". */
  label: string;
  className?: string;
}) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const failed = result === "failed";
  const feedback = failed ? "Couldn't copy. Try again or select and copy the text." : "Copied";
  return (
    <button
      type="button"
      aria-label={label}
      title={result === "idle" ? label : feedback}
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground",
        CONTROL_HOVER_TRANSITION,
        failed && "text-destructive-text",
        className,
      )}
      onClick={async (event) => {
        // Copy controls sit inside rows that open or expand on click.
        event.stopPropagation();
        window.clearTimeout(timer.current);
        setResult("idle");
        try {
          await navigator.clipboard.writeText(value);
          setResult("copied");
          timer.current = window.setTimeout(() => setResult("idle"), COPIED_FEEDBACK_MS);
        } catch {
          setResult("failed");
        }
      }}
    >
      <Icon
        name={result === "copied" ? "Check" : failed ? "AlertTriangle" : "Copy"}
        className="size-3"
        aria-hidden
      />
      <output className="sr-only">{result === "idle" ? "" : feedback}</output>
    </button>
  );
}
