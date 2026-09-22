import { useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon, type IconName } from "../ui/icon";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import {
  findThreadAction,
  type DispatchRowCommand,
  type ThreadActionPlan,
} from "./thread-actions";
import { threadDisplayTitle } from "../../lib/inbox";
import { RenameThreadDialog } from "./rename-thread-dialog";

/**
 * The desktop menu adds BB's normal actions after the GTD lifecycle moves.
 * Pass `disabled` on the compact viewport, where the row runs
 * its own 500 ms long press: Radix keeps a 700 ms touch timer of its own and
 * would open a second menu on top.
 */
export function RowContextMenu({
  thread,
  command,
  plan,
  disabled = false,
  children,
}: {
  thread: PluginSidebarThread;
  command: DispatchRowCommand;
  plan: ThreadActionPlan;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
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

  return (
    <>
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
            {plan
              .filter(({ id }) => id !== "toggle-pin" && id !== "request-delete")
              .map((action) => (
                <MenuAction key={action.id} icon={action.icon} onSelect={action.execute}>
                  {action.label}
                </MenuAction>
              ))}
            <MenuSeparator />
            <MenuAction
              icon="Columns2"
              onSelect={() =>
                command({
                  kind: "open-in-split",
                  threadId: thread.id,
                })
              }
            >
              Open in split
            </MenuAction>
            <MenuSeparator />
            <MenuAction
              icon="Copy"
              onSelect={() => {
                void copyLink();
              }}
            >
              Copy thread link
            </MenuAction>
            <MenuAction
              icon={thread.isUnread ? "MailOpen" : "Mail"}
              onSelect={() =>
                command({
                  kind: "set-read",
                  threadId: thread.id,
                  read: thread.isUnread,
                })
              }
            >
              {thread.isUnread ? "Mark read" : "Mark unread"}
            </MenuAction>
            {pin && (
              <MenuAction icon={pin.icon} onSelect={pin.execute}>
                {pin.label}
              </MenuAction>
            )}
            <MenuAction icon="Edit" onSelect={() => setRenaming(true)}>
              Rename
            </MenuAction>
            <MenuSeparator />
            {remove && (
              <MenuAction icon={remove.icon} onSelect={remove.execute} destructive>
                {remove.label}
              </MenuAction>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {renaming && (
        <RenameThreadDialog
          threadId={thread.id}
          initialTitle={threadDisplayTitle(thread)}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}

const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent";

function MenuAction({
  icon,
  onSelect,
  destructive,
  children,
}: {
  icon: IconName;
  onSelect: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        ITEM_CLASS,
        destructive ? "text-destructive-text" : "data-[highlighted]:text-accent-foreground",
      )}
    >
      <Icon name={icon} className="size-4 shrink-0" />
      {children}
    </ContextMenu.Item>
  );
}

function MenuSeparator() {
  return <ContextMenu.Separator className="mx-2 my-1.5 h-px bg-border" />;
}
