/* shadcn/ui-derived */
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      autoComplete="off"
      className={cn(
        "h-7 w-full min-w-0 rounded-[6px] border border-solid border-border bg-transparent px-2 text-[12px] leading-4 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
