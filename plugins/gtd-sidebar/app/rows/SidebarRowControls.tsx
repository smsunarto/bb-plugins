import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SIDEBAR_CONTROL_PAIR_GAP_CLASS,
  SIDEBAR_CONTROL_PRIMARY_BUTTON_CLASS,
} from "@/components/ui/sidebar-row-classes";

const MENU_SIDE_OFFSET = 8;

/**
 * A menu whose trigger comes before the primary action opens past the row's
 * edge, clear of the button after it. Call `measure` as the menu opens.
 */
export function useMenuPastControls() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [sideOffset, setSideOffset] = useState(MENU_SIDE_OFFSET);
  const measure = () => {
    const button = trigger.current;
    const controls = button?.closest("[data-sidebar-row-controls]");
    const after =
      button && controls
        ? controls.getBoundingClientRect().right - button.getBoundingClientRect().right
        : 0;
    setSideOffset(MENU_SIDE_OFFSET + Math.max(0, after));
  };
  return { trigger, sideOffset, measure };
}

export function SidebarRowControls({
  primaryAction,
  primaryLast = false,
  children,
}: {
  primaryAction: ReactNode;
  /** Puts the primary action after the other controls, at the row's edge. */
  primaryLast?: boolean;
  children?: ReactNode;
}) {
  return (
    <span
      data-sidebar-row-controls=""
      className={cn("inline-flex shrink-0 items-center", SIDEBAR_CONTROL_PAIR_GAP_CLASS)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation();
        }
      }}
    >
      {primaryLast ? children : primaryAction}
      {primaryLast ? primaryAction : children}
    </span>
  );
}

export function SidebarControlButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip delayDuration={350} disableHoverableContent>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          className={SIDEBAR_CONTROL_PRIMARY_BUTTON_CLASS}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail > 0) event.currentTarget.blur();
            onClick();
          }}
        >
          <Icon name={icon} className={COARSE_POINTER_ICON_SIZE_CLASS} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
