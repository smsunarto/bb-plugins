import { Fragment } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { getThreadActionGroups, type ThreadActionPlan } from "@/components/inbox/thread-actions";

export function CompactThreadActionMenu({ plan }: { plan: ThreadActionPlan }) {
  const groups = getThreadActionGroups(plan);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More thread actions"
          title="More thread actions"
          onPointerDown={(event) => event.stopPropagation()}
          className="pointer-events-auto relative z-[1] flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...usePortalScopeProps()}
          aria-label="Thread actions"
          align="end"
          sideOffset={4}
          onPointerDown={(event) => event.stopPropagation()}
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index === 0 ? null : <DropdownMenu.Separator className="my-1 h-px bg-border" />}
              {group.actions.map((action) => (
                <DropdownMenu.Item
                  key={action.id}
                  onSelect={action.execute}
                  className={cn(
                    "flex min-h-10 cursor-pointer select-none items-center rounded-md px-2 text-sm outline-none",
                    "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                    group.id === "destructive" && "text-destructive-text",
                  )}
                >
                  {action.label}
                </DropdownMenu.Item>
              ))}
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
