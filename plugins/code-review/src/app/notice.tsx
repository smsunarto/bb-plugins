import { useEffect, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";
import { cn } from "./lib/utils.ts";

const TONE = {
  error: {
    icon: "AlertTriangle",
    box: "border-surface-destructive-border bg-surface-destructive",
    iconTone: "text-destructive-text",
  },
  info: { icon: "Info", box: "border-border bg-card", iconTone: "text-subtle-foreground" },
} as const;

/**
 * The panel's one way of saying "nothing to draw here, and why". An error is
 * announced as it appears. `action` is the next step: a retry, or a link.
 */
export function Notice({
  tone,
  title,
  action,
  className,
  children,
}: {
  tone: "error" | "info";
  /** A short bold line above the detail. */
  title?: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const look = TONE[tone];
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex gap-2 rounded-md border px-3 py-2.5 text-xs text-muted-foreground",
        look.box,
        className,
      )}
    >
      <Icon name={look.icon} className={cn("mt-px size-3.5 shrink-0", look.iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-foreground">{title}</p> : null}
        {children ? (
          <div className={cn("leading-normal [overflow-wrap:anywhere]", title && "mt-0.5")}>
            {children}
          </div>
        ) : null}
        {action ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{action}</div> : null}
      </div>
    </div>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The request failed without an error message.";
}

/** The `action` of an error `Notice` whose read can simply be asked again. */
export function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-2.5 text-xs font-normal"
      onClick={onRetry}
    >
      Try again
    </Button>
  );
}

/** One line in place of a small part that failed to load, with a way to ask again. */
export function InlineError({
  what,
  error,
  onRetry,
}: {
  /** What failed, after "Could not load", e.g. "checks". */
  what: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <p className="text-destructive-text">
      Could not load {what}: {errorText(error)}{" "}
      <Button variant="link" size="sm" className="h-auto p-0 text-xs font-normal" onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}

/**
 * A titled part of a page: a small heading over its content. `aside` sits on
 * the heading's line after the title; give it `ms-auto` to push it to the end.
 */
export function Section({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("min-w-0", className)}>
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={id} className="text-[11px] font-semibold text-subtle-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// A read that answers inside this draws nothing in between, so a fast one
// never flashes a placeholder for a frame or two.
const LOADING_DELAY_MS = 200;

// Ragged widths, so the placeholder reads as lines of text and not a table.
const ROW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5", "w-3/5"];

/** True once `delay` has passed since mount. */
function useDelayed(delay: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setElapsed(true), delay);
    return () => window.clearTimeout(id);
  }, [delay]);
  return elapsed;
}

/**
 * Lines standing in for content on its way, after a short delay. The label
 * is for screen readers, through `output`, the native polite live region.
 */
export function Loading({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  const shown = useDelayed(LOADING_DELAY_MS);
  return (
    <output aria-busy className={cn("flex flex-col gap-2.5", className)}>
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
 * A hover and keyboard-focus hint for an icon-only control, which carries
 * its own `aria-label`. Needs the page's `TooltipProvider` above it.
 */
export function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
