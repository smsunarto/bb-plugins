import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// A small filled circle that marks a row's or a badge's status. It is decorative unless the
// caller names it: pass `aria-label` (and `role="img"`) when the dot is the only status cue.
const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    tone: {
      neutral: "bg-muted-foreground",
      primary: "bg-primary",
      success: "bg-success",
      warning: "bg-warning",
      destructive: "bg-destructive",
      info: "bg-(--timeline-accent,var(--primary))",
    },
    size: {
      default: "size-2",
      sm: "size-1.5",
    },
  },
  defaultVariants: { tone: "neutral", size: "default" },
});

function StatusDot({
  className,
  tone,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden={props["aria-label"] ? undefined : true}
      className={cn(statusDotVariants({ tone, size }), className)}
      {...props}
    />
  );
}

export { StatusDot, statusDotVariants };
