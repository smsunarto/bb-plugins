import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";

export const badgeVariants = cva(styles["badge"], {
  variants: {
    variant: {
      default: styles["badge-default"],
      secondary: styles["badge-secondary"],
      destructive: styles["badge-destructive"],
      outline: styles["badge-outline"],
      count: styles["badge-count"],
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
