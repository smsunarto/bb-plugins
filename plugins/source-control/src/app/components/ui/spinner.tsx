import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils.ts";

/** shadcn's Spinner, drawn with bb's icon. Decorative: the busy control says what is loading. */
function Spinner({ className }: { className?: string }) {
  return (
    <Icon
      name="Spinner"
      className={cn("size-3.5 shrink-0 animate-spin motion-reduce:animate-none", className)}
      aria-hidden
    />
  );
}

export { Spinner };
