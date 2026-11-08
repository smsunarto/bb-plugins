import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

/** Card body copy: muted, so the title leads, with a tidier last line. */
export const cardTextClass =
  "text-xs leading-[1.55] text-muted-foreground text-pretty [overflow-wrap:anywhere]";

/**
 * One item in the thread Info tab's bot sections, always open. The header holds
 * the title, an optional subtitle and a trailing fact, set tight together; the
 * body sits a larger step below so each card reads as heading, then content.
 */
export function ResourceCard({
  title,
  subtitle,
  meta,
  metaTone = "muted",
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  meta?: ReactNode;
  metaTone?: "muted" | "danger";
  children?: ReactNode;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <header className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]">
            {title}
          </h4>
          {meta ? (
            <span
              className={cn(
                "shrink-0 text-[11px] tabular-nums",
                metaTone === "danger" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {meta}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground tabular-nums">
            {subtitle}
          </p>
        ) : null}
      </header>
      {children ? (
        <div className="mt-2 flex min-w-0 flex-col items-start gap-2">{children}</div>
      ) : null}
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
      className="-mx-1 rounded-sm px-1 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
      <div className={cn("w-full", className, long && !open && "line-clamp-4")}>{text}</div>
      {long ? (
        <CardToggle open={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </CardToggle>
      ) : null}
    </>
  );
}
