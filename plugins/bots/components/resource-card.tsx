import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * One item in the thread Info tab's bot sections, always open: title, a muted
 * trailing fact, and its content underneath.
 */
export function ResourceCard({
  title,
  meta,
  metaTone = "muted",
  children,
}: {
  title: string;
  meta?: ReactNode;
  metaTone?: "muted" | "danger";
  children?: ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <header className="flex min-w-0 items-start gap-2 text-xs">
        <h4 className="min-w-0 flex-1 font-medium text-foreground [overflow-wrap:anywhere]">
          {title}
        </h4>
        {meta ? (
          <span
            className={cn(
              "shrink-0 tabular-nums",
              metaTone === "danger" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {meta}
          </span>
        ) : null}
      </header>
      {children ? <div className="mt-1.5 min-w-0 space-y-1.5">{children}</div> : null}
    </article>
  );
}

/** The quiet text button a card uses to reveal more of itself. */
export function CardToggle({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="-mx-1 rounded-sm px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** Text clamped to four lines, with Show all only when the text can run longer. */
export function ClampedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  // A cheap length check instead of measuring, so mounting forces no layout.
  const long = text.length > 240 || text.split("\n").length > 4;
  return (
    <>
      <div className={cn(className, long && !open && "line-clamp-4")}>{text}</div>
      {long ? (
        <CardToggle open={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </CardToggle>
      ) : null}
    </>
  );
}
