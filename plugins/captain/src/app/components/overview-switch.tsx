import * as React from "react";
import { cn } from "../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./ui/motion.ts";

type SwitchProps = Omit<React.ComponentPropsWithoutRef<"button">, "onChange" | "role"> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/**
 * A 16×28 track inside a 32px button, so the hit area stays on the Overview's
 * grid; a coarse pointer grows it to 44px.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, className, disabled, onCheckedChange, onClick, ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "group/switch inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg outline-none focus-visible:outline-1 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(!checked);
      }}
    >
      <span
        aria-hidden
        data-state={checked ? "checked" : "unchecked"}
        className={cn(
          `inline-flex h-4 w-7 items-center rounded-full border border-transparent shadow-xs ${CONTROL_HOVER_TRANSITION} data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted-foreground/40`,
        )}
      >
        <span
          data-state={checked ? "checked" : "unchecked"}
          className="pointer-events-none block size-3 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0"
        />
      </span>
    </button>
  ),
);
Switch.displayName = "Switch";

export { Switch };
