import { forwardRef, useState, type ReactElement, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** How long the pointer rests on a control before its tooltip shows (inputs.tsx's hint delay). */
const TOOLTIP_DELAY_MS = 300;

/**
 * BB's tooltip on one control, with its own provider so it works in gallery
 * chrome as well as inside a block. The content mounts only while open: its
 * portal reads BB's settings, which a closed tooltip never needs.
 */
export function WithTooltip({
  tip,
  layer,
  children,
}: {
  tip: ReactNode;
  /** A stacking class for a tooltip over a layer above BB's overlays (viewer.tsx's full screen). */
  layer?: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <Tooltip open={open} onOpenChange={setOpen} disableHoverableContent>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {open ? (
          <TooltipContent className={cn("pointer-events-none", layer)}>{tip}</TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "variant" | "size" | "children"> {
  /** The accessible name, also the tooltip unless `tooltip` says it shorter. */
  label: string;
  tooltip?: ReactNode;
  /** As WithTooltip's `layer`. */
  tooltipLayer?: string;
  children: ReactNode;
}

/** An icon-only control: BB's ghost icon Button at the catalog's 24px, its label as tooltip and accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip, tooltipLayer, className, type = "button", ...props },
  ref,
) {
  return (
    <WithTooltip tip={tooltip ?? label} layer={tooltipLayer}>
      <Button
        ref={ref}
        type={type}
        variant="ghost"
        size="icon"
        aria-label={label}
        className={cn(
          "size-6 text-muted-foreground [&_[data-icon-root]]:size-3.5 [&_svg]:size-3.5",
          className,
        )}
        {...props}
      />
    </WithTooltip>
  );
});
