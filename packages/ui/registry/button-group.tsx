import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";
import { Separator } from "./separator";

/** Vega's button group, with selectors that end in an attribute so no rule falls into Blink's
 * universal bucket. Children are kit controls, which all carry `data-slot`. */
const buttonGroupVariants = cva(
  "group/button-group flex w-fit items-stretch has-[>[data-slot=button-group]]:gap-2 [&>[data-slot]:focus-visible]:relative [&>[data-slot]:focus-visible]:z-10 [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal:
          "[&>[data-slot]+[data-slot]]:rounded-l-none [&>[data-slot]+[data-slot]]:border-l-0 [&>[data-slot]:has(+[data-slot])]:rounded-r-none",
        vertical:
          "flex-col [&>[data-slot]+[data-slot]]:rounded-t-none [&>[data-slot]+[data-slot]]:border-t-0 [&>[data-slot]:has(+[data-slot])]:rounded-b-none",
      },
    },
    defaultVariants: { orientation: "horizontal" },
  },
);

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation ?? "horizontal"}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  );
}

function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="button-group-text"
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted px-2.5 text-sm font-medium shadow-xs [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "relative self-stretch bg-input data-[orientation=horizontal]:mx-px data-[orientation=horizontal]:w-auto data-[orientation=vertical]:my-px data-[orientation=vertical]:h-auto",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants };
