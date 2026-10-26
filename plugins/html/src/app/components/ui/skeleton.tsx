import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-pulse rounded-md bg-surface-selected", className)} {...props} />
  );
}
