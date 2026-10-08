import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

/** A block standing in for content that has not arrived, shaped like it. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-surface-selected motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}
