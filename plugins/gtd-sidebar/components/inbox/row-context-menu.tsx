import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { ThreadActionPlan } from "@/components/inbox/thread-actions";

/**
 * The desktop menu: the same short list as the phone sheet, so both inputs
 * teach one menu. Pass `disabled` on the compact viewport, where the row runs
 * its own 500 ms long press: Radix keeps a 700 ms touch timer of its own and
 * would open a second menu on top.
 */
export function RowContextMenu({
  plan,
  disabled = false,
  children,
}: {
  plan: ThreadActionPlan;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={disabled}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...usePortalScopeProps()}
          aria-label="Thread actions"
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {plan.map((action) => (
            <ContextMenu.Item
              key={action.id}
              onSelect={action.execute}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
                "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                action.destructive && "text-destructive-text",
              )}
            >
              <Icon name={action.icon} className="size-4 shrink-0" />
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
