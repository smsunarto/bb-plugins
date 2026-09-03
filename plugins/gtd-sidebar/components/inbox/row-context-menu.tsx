import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { type ThreadActionPlan } from "@/components/inbox/thread-actions";
import { getCompactActions } from "@/components/inbox/thread-action-menu";

/**
 * The desktop menu. Pass `disabled` on the compact viewport, where the row
 * runs its own 500 ms long press: Radix keeps a 700 ms touch timer of its
 * own and would open a second menu on top.
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
  const actions = getCompactActions(plan);

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
          {actions.map((action) => (
            <Item
              key={action.id}
              icon={action.icon}
              destructive={action.destructive}
              onSelect={action.execute}
            >
              {action.label}
            </Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  children,
  icon,
  destructive = false,
  onSelect,
}: {
  children: ReactNode;
  icon: IconName;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        destructive && "text-destructive-text",
      )}
    >
      <Icon name={icon} className="size-4 shrink-0" />
      {children}
    </ContextMenu.Item>
  );
}
