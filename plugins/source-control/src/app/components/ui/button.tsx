/* shadcn/ui-derived */
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * Tailwind only, no shared stylesheet: every selector ends in a class, tag or
 * attribute (see `src/css.test.ts`). `sm`, the default, is the panel's 28px
 * control height so rows, placeholders and buttons line up.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default: "border-0 bg-foreground font-semibold text-background enabled:hover:opacity-90",
        destructive:
          "border-0 bg-destructive font-semibold text-destructive-foreground enabled:hover:opacity-90",
        outline:
          "border border-solid border-border-hairline bg-transparent text-foreground enabled:hover:bg-surface-raised",
        secondary: "border-0 bg-surface-raised text-foreground enabled:hover:bg-border",
        ghost: "border-0 bg-transparent text-foreground enabled:hover:bg-surface-raised",
        link: "border-0 bg-transparent px-0 text-foreground underline-offset-4 enabled:hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-[12px] leading-4",
        default: "h-8 px-3 text-[13px] leading-5",
        icon: "size-7 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "sm" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
