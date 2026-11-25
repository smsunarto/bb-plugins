import type { ReactElement } from "react";
import { StatusDot } from "../../components/ui/status-dot.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.tsx";

/** Shows `label` on hover or keyboard focus of its one child, which must accept a ref. */
export function Hint({ label, children }: { label: string; children: ReactElement }) {
  if (label === "") return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The dot that marks a row with unsaved edits; screen readers hear "Unsaved". */
export function UnsavedDot({ className }: { className?: string }) {
  return (
    <>
      <Hint label="Unsaved">
        <StatusDot tone="primary" size="sm" className={className} />
      </Hint>
      <span className="sr-only">Unsaved</span>
    </>
  );
}
