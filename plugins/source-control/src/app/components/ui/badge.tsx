import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center rounded-md border border-solid px-2 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-foreground text-background",
        secondary: "border-transparent bg-surface-raised text-muted-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        /** GitButler's solid count pill. */
        count:
          "h-4 rounded-full border-transparent bg-surface-raised px-1.5 py-0 leading-none text-muted-foreground tabular-nums",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
