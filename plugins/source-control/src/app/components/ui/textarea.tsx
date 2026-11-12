/* shadcn/ui-derived */
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-16 w-full min-w-0 rounded-[6px] border border-solid border-border bg-transparent px-2 py-1.5 text-[12px] leading-4 text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
