import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { cn } from "./lib/utils.ts";

/**
 * The panel's one way of saying "nothing to draw here, and why". An empty or
 * unavailable state carries an icon and, where there is one, the next step.
 */
export function Notice({
  title,
  detail,
  onRetry,
  icon,
  action,
}: {
  title: string;
  detail?: ReactNode;
  onRetry?: () => void;
  /** A bb icon name, drawn above the title. */
  icon?: string;
  /** The next step, beside Try again: a button, or a command to run. */
  action?: ReactNode;
}) {
  return (
    <div className="my-4 rounded-md border border-border bg-card px-3 py-2.5 text-muted-foreground">
      {icon ? (
        <Icon name={icon} className="mb-1.5 size-4 text-subtle-foreground" aria-hidden />
      ) : null}
      <p className="font-semibold text-foreground">{title}</p>
      {/* Detail wraps to several lines often enough to need reading leading. */}
      {detail ? <p className="mt-1 leading-normal [overflow-wrap:anywhere]">{detail}</p> : null}
      {onRetry || action ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {onRetry ? (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2.5 text-xs font-normal"
              onClick={onRetry}
            >
              Try again
            </Button>
          ) : null}
          {action}
        </div>
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

/**
 * The shell of every layout-shaped placeholder below. Unlike `Loading` it
 * draws nothing at all for the first moment, label included, so a fast read
 * neither flashes bars nor makes a screen reader say "loading" for nothing.
 */
function Placeholder({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const shown = useDelayed(LOADING_DELAY_MS);
  if (!shown) return null;
  return (
    <div
      aria-busy
      className={cn("duration-150 motion-safe:animate-in motion-safe:fade-in-0", className)}
    >
      <output className="sr-only">{label}</output>
      {children}
    </div>
  );
}

/** Commit rows as a branch card draws them: the rail's dot, a subject, and a time. */
function CommitBars({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, index) => (
    <div key={index} className="flex h-8 items-center pe-2.5">
      <span className="flex w-10 shrink-0 justify-center">
        <Skeleton className="size-2.5 rounded-full" />
      </span>
      <Skeleton className={cn("h-3", ROW_WIDTHS[index % ROW_WIDTHS.length])} />
      <Skeleton className="ms-auto h-3 w-8" />
    </div>
  ));
}

const BOARD_CARDS = [
  { width: "w-2/5", commits: 3 },
  { width: "w-1/3", commits: 2 },
];

/** The board on its way: two branch cards, each a header over a few commits. */
export function WorkspaceSkeleton({ label }: { label: string }) {
  return (
    <Placeholder label={label} className="flex flex-col gap-4">
      {BOARD_CARDS.map((card) => (
        <div key={card.width} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 px-2.5 py-2">
            <Skeleton className="size-5" />
            <Skeleton className={cn("h-3", card.width)} />
          </div>
          <CommitBars rows={card.commits} />
        </div>
      ))}
    </Placeholder>
  );
}

/** Commit rows on their way, inside a card that is already drawn. */
export function CommitRowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <Placeholder label={label}>
      <CommitBars rows={rows} />
    </Placeholder>
  );
}

/** File rows on their way, at the file list's row height: an icon and a path. */
export function FileRowsSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <Placeholder label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7.5 items-center gap-2 ps-3.5 pe-2">
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className={cn("h-3", ROW_WIDTHS[index % ROW_WIDTHS.length])} />
        </div>
      ))}
    </Placeholder>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed without an error message.";
}
