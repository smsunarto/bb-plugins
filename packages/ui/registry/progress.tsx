import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "../../lib/utils";

type ProgressProps = React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
  /** Colours the fill, such as a tone. */
  indicatorClassName?: string;
  /** Reaches the fill, such as for an entrance animation. */
  indicatorRef?: React.Ref<HTMLDivElement>;
  /** Extra fill style, such as a timing function; the width is always set from value. */
  indicatorStyle?: React.CSSProperties;
};

// From the @bb registry at desktop-v0.49.0. The fill grows by width rather than
// translateX, so an entrance can scale it from the left edge, and it takes a
// tone class and a ref.
const Progress = React.forwardRef<React.ComponentRef<typeof ProgressPrimitive.Root>, ProgressProps>(
  (
    { className, value, max = 100, indicatorClassName, indicatorRef, indicatorStyle, ...props },
    ref,
  ) => {
    const ratio = max > 0 ? Math.min(1, Math.max(0, (value ?? 0) / max)) : 0;
    return (
      <ProgressPrimitive.Root
        ref={ref}
        value={value}
        max={max}
        className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
        {...props}
      >
        <ProgressPrimitive.Indicator
          ref={indicatorRef}
          className={cn(
            "block h-full origin-left rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none",
            indicatorClassName,
          )}
          style={{ ...indicatorStyle, width: `${ratio * 100}%` }}
        />
      </ProgressPrimitive.Root>
    );
  },
);
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
