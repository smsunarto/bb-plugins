import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

/** A block standing in for content that has not arrived, shaped like it. */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(
        "shrink-0 rounded-[4px] bg-surface-raised motion-safe:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
