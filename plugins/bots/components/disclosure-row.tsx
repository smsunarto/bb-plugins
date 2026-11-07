import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * One folded row in the thread Info tab's bot sections: chevron, title, and a
 * muted trailing fact, with the body indented under the title.
 */
export function DisclosureRow({
  title,
  meta,
  metaTone = "muted",
  onToggle,
  children,
}: {
  title: string;
  meta?: ReactNode;
  metaTone?: "muted" | "danger";
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="group min-w-0"
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
    >
      <summary className="-mx-1 flex min-h-7 cursor-pointer list-none items-start gap-1.5 rounded-sm px-1 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className="mt-px shrink-0 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
        >
          <path
            d="M4.5 2.5 8 6l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">{title}</span>
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
      </summary>
      <div className="mb-2 ml-[18px] mt-0.5 min-w-0">{children}</div>
    </details>
  );
}
