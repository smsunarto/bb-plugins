import { useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils.ts";
import { CONTROL_HOVER_TRANSITION } from "./components/ui/motion.ts";

const COPIED_FEEDBACK_MS = 1_200;

/**
 * An icon button that copies `value` and turns into a check for a moment.
 * The check is also said aloud: an icon swap alone tells a screen reader
 * nothing. A clipboard the browser refuses leaves the icon as it was.
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
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
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
        // Copy controls sit inside rows that open or expand on click.
        event.stopPropagation();
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
          },
          () => {},
        );
      }}
    >
      <Icon name={copied ? "Check" : "Copy"} className="size-3" aria-hidden />
      <output className="sr-only">{copied ? "Copied" : ""}</output>
    </button>
  );
}
