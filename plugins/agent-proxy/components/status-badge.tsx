import { cn } from "@/lib/utils";
import type { CoreStatus } from "../server";

export const CORE_STATE_STYLES: Record<CoreStatus["state"], { dot: string; label: string }> = {
  "not-installed": { dot: "bg-muted-foreground", label: "Not installed" },
  stopped: { dot: "bg-muted-foreground", label: "Stopped" },
  starting: { dot: "bg-amber-500", label: "Starting…" },
  running: { dot: "bg-emerald-500", label: "Running" },
  stopping: { dot: "bg-amber-500", label: "Stopping…" },
  crashed: { dot: "bg-destructive", label: "Crashed" },
};

export function StatusBadge({ state, className }: { state: CoreStatus["state"]; className?: string }) {
  const style = CORE_STATE_STYLES[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-foreground", className)}>
      <span className={cn("size-2 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
}
