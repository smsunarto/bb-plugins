/* shadcn/ui-derived */
import * as React from "react";

import {
  COARSE_POINTER_INPUT_HEIGHT_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
} from "./coarse-pointer-sizing.js";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

// The edge is --border, not --input. A theme may define --input as the well's
// fill rather than an edge color (bb's own token contract says exactly that:
// "the fill is the load-bearing role … the visible edge comes from --border /
// --ring"), in which case border-input paints a different line from every
// other bordered surface in the panel — the file tree above all, which this
// field sits directly against.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        autoComplete="off"
        className={cn(
          `flex w-full rounded-md border border-border bg-transparent px-3 py-1 ${CONTROL_HOVER_TRANSITION} file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50`,
          COARSE_POINTER_INPUT_HEIGHT_CLASS,
          COARSE_POINTER_TEXT_BASE_CLASS,
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
