import { Fragment, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { getThreadActionGroups, type ThreadActionPlan } from "@/components/inbox/thread-actions";

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
  const groups = getThreadActionGroups(plan);

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
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index === 0 ? null : <Separator />}
              {group.actions.map((action) => (
                <Item
                  key={action.id}
                  destructive={group.id === "destructive"}
                  onSelect={action.execute}
                >
                  {action.label}
                </Item>
              ))}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  children,
  destructive = false,
  onSelect,
}: {
  children: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        destructive && "text-destructive-text",
      )}
    >
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
