import { Fragment } from "react";
import { useSettings, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { attachHapticTrigger } from "../../lib/ios-haptics";
import {
  findThreadAction,
  type DispatchRowCommand,
  type ThreadAction,
  type ThreadActionPlan,
} from "./thread-actions";
import type { ThreadRename } from "./inline-rename";

export interface ThreadMenuActionsProps {
  thread: PluginSidebarThread;
  command: DispatchRowCommand;
  plan: ThreadActionPlan;
  rename: ThreadRename;
  canSplit: boolean;
}

/** One action order and set of handlers for desktop and compact row menus. */
export function ThreadMenuActions({
  thread,
  command,
  plan,
  rename,
  compact = false,
  canSplit,
  haptics = true,
  closeMenu,
}: ThreadMenuActionsProps & { compact?: boolean; haptics?: boolean; closeMenu?: () => void }) {
  const { values } = useSettings();
  const Menu = compact ? DropdownMenu : ContextMenu;
  const pin = findThreadAction(plan, "toggle-pin");
  const remove = findThreadAction(plan, "request-delete");
  async function copyLink() {
    try {
      const url = new URL(
        `/projects/${thread.projectId}/threads/${thread.id}`,
        window.location.origin,
      );
      await navigator.clipboard.writeText(url.toString());
      toast.success("Thread link copied");
    } catch {
      toast.error("Failed to copy thread link");
    }
  }

  const groups: Pick<ThreadAction, "label" | "icon" | "execute" | "destructive">[][] = [
    plan.filter(({ id }) => id !== "toggle-pin" && id !== "request-delete"),
    canSplit
      ? [
          {
            label: "Open in split",
            icon: "Columns2",
            execute: () => command({ kind: "open-in-split", threadId: thread.id }),
          },
        ]
      : [],
    [
      {
        label: "Copy thread link",
        icon: "Copy",
        execute: () => {
          void copyLink();
        },
      },
      {
        label: thread.isUnread ? "Mark read" : "Mark unread",
        icon: thread.isUnread ? "MailOpen" : "Mail",
        execute: () => command({ kind: "set-read", threadId: thread.id, read: thread.isUnread }),
      },
      ...(pin ? [pin] : []),
      { label: "Rename", icon: "Edit", execute: () => rename.startEditingFromMenu(closeMenu) },
    ],
    remove ? [remove] : [],
  ];

  return groups
    .filter((group) => group.length > 0)
    .map((group, index) => (
      <Fragment key={group[0]?.label}>
        {index > 0 && <Menu.Separator className="mx-2 my-1.5 h-px bg-border" />}
        {group.map((action) => (
          <Menu.Item
            key={action.label}
            ref={
              compact
                ? (element) => {
                    if (haptics && values?.mobileHaptics === true) attachHapticTrigger(element);
                    else element?.querySelector("[data-haptic-trigger]")?.remove();
                  }
                : undefined
            }
            onSelect={action.execute}
            className={cn(
              compact
                ? "relative flex h-[44px] cursor-default select-none items-center gap-3.5 px-4 text-[16px] font-normal leading-none tracking-[-0.01em] outline-none data-[highlighted]:bg-black/[0.06] dark:data-[highlighted]:bg-white/10"
                : "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent",
              action.destructive
                ? "text-destructive-text"
                : "data-[highlighted]:text-accent-foreground",
            )}
          >
            <Icon
              name={action.icon}
              className={compact ? "size-[20px] shrink-0" : "size-4 shrink-0"}
            />
            <span className="truncate">{action.label}</span>
          </Menu.Item>
        ))}
      </Fragment>
    ));
}
