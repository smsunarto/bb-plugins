import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "../../lib/utils";

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  /** Names the thumb, which is the element that carries role=slider. */
  thumbLabel?: string;
  /** Reads the value aloud in words, such as "plus or minus 8 of 255 per channel". */
  thumbValueText?: string;
  /** Labels the thumb by another element's id, such as a visible Label. */
  thumbLabelledBy?: string;
};

// From the @bb registry at desktop-v0.49.0. The thumb takes a label and value
// text, since Radix puts role=slider on the thumb rather than the root.
const Slider = React.forwardRef<React.ComponentRef<typeof SliderPrimitive.Root>, SliderProps>(
  ({ className, thumbLabel, thumbValueText, thumbLabelledBy, ...props }, ref) => (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={thumbLabel}
        aria-labelledby={thumbLabelledBy}
        aria-valuetext={thumbValueText}
        className="block size-4 cursor-pointer rounded-full border border-border bg-background shadow-sm transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:scale-110 disabled:pointer-events-none"
      />
    </SliderPrimitive.Root>
  ),
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
