import * as React from "react";
import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

const toggleVariants = cva(
  // Vega's toggle in theme colors: --state-hover on hover, and --state-active when on, so
  // the on-state stays distinct from hover in themes whose --accent is the hover tint. Off
  // items keep muted text, which still marks the on item where a theme repaints the fill.
  `group/toggle inline-flex cursor-pointer items-center justify-center gap-1 rounded-md border border-transparent text-sm font-medium whitespace-nowrap text-muted-foreground outline-none ${CONTROL_HOVER_TRANSITION} hover:bg-state-hover hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-state-active data-[state=on]:text-foreground [&_[data-icon-root]]:pointer-events-none [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0`,
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border-input bg-transparent shadow-xs",
      },
      size: {
        default: "h-9 min-w-9 px-2.5",
        sm: "h-8 min-w-8 px-2.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    data-slot="toggle"
    data-variant={variant}
    data-size={size}
    className={cn(toggleVariants({ variant, size, className }))}
    {...props}
  />
));

Toggle.displayName = TogglePrimitive.Root.displayName;

export { Toggle, toggleVariants };
