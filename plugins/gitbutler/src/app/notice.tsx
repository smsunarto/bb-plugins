import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { cn } from "./lib/utils.ts";

/** The panel's one way of saying "nothing to draw here, and why". */
export function Notice({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="my-4 rounded-md border border-border bg-card px-3 py-2.5 text-muted-foreground">
      <p className="font-semibold text-foreground">{title}</p>
      {/* Detail wraps to several lines often enough to need reading leading. */}
      {detail ? <p className="mt-1 leading-normal [overflow-wrap:anywhere]">{detail}</p> : null}
      {onRetry ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-6 px-2.5 text-xs font-normal"
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

// A read that answers inside this draws nothing in between, so a fast one
// never flashes a placeholder for a frame or two.
const LOADING_DELAY_MS = 200;

// Ragged widths, so the placeholder reads as rows of text and not a table.
const ROW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5", "w-3/5"];

/** True once `delay` has passed since mount. */
export function useDelayed(delay: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setElapsed(true), delay);
    return () => window.clearTimeout(id);
  }, [delay]);
  return elapsed;
}

/**
 * Rows standing in for a list on its way, after a short delay. The label is
 * for screen readers: the panel refetches on its own, so a load needs
 * announcing rather than only drawing, and `output` is the native polite
 * live region.
 */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  const shown = useDelayed(LOADING_DELAY_MS);
  return (
    <output className="my-2.5 flex flex-col gap-2.5 px-0.5" aria-busy>
      <span className="sr-only">{label}</span>
      {shown
        ? Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} className={cn("h-3", ROW_WIDTHS[index % ROW_WIDTHS.length])} />
          ))
        : null}
    </output>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed without an error message.";
}
