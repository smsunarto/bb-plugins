import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import type { IconName } from "@/components/ui/icon";

/** A view-sized empty state: the kit's icon and message, then an optional explanation and action. */
export function ViewEmptyState({
  icon,
  heading,
  description,
  action,
}: {
  icon: IconName;
  heading: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex flex-col items-center gap-1">
        <EmptyState
          icon={icon}
          message={heading}
          messageClassName="text-sm font-medium text-foreground"
        />
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
