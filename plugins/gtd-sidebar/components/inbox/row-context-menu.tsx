import { useEffect, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import {
  findThreadAction,
  type DispatchRowCommand,
  type ThreadActionPlan,
} from "@/components/inbox/thread-actions";
import type { threadMenuRpcContract } from "@/lib/thread-menu-rpc";
import { threadDisplayTitle } from "@/lib/inbox";
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
            {!thread.isArchived && thread.parentThreadId === null && (
              <SectionMoveMenu thread={thread} />
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

function SectionMoveMenu({ thread }: { thread: PluginSidebarThread }) {
  const rpc = useRpc<typeof threadMenuRpcContract>();
  const scope = usePortalScopeProps();
  const [sections, setSections] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    rpc.call("listThreadMenuSections", {}).then(
      (result) => {
        if (active) setSections(result.sections);
        return undefined;
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  if (error)
    return (
      <ContextMenu.Item disabled className={ITEM_CLASS}>
        Unable to load sections
      </ContextMenu.Item>
    );
  if (sections === null) return null;
  const destinations = [{ id: null, name: "Threads" }, ...sections];
  const isCurrent = (id: string | null) => !thread.isPinned && thread.sectionId === id;
  if (destinations.every(({ id }) => isCurrent(id))) return null;

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={ITEM_CLASS}>
        <Icon name="MoveTo" className="size-4 shrink-0" />
        Move to section
        <Icon name="ChevronRight" className="ml-auto size-4 shrink-0" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...scope}
          className="z-50 max-h-[min(24rem,calc(100vh-2rem))] min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {destinations.map(({ id, name }) => (
            <ContextMenu.Item
              key={id ?? "threads"}
              disabled={isCurrent(id)}
              aria-current={isCurrent(id) ? "true" : undefined}
              className={ITEM_CLASS}
              onSelect={() => {
                void rpc
                  .call("moveThreadToSection", { threadId: thread.id, sectionId: id })
                  .catch(() => toast.error("Failed to move thread to section"));
              }}
            >
              {name}
              {isCurrent(id) && <Icon name="Check" className="ml-auto size-4" />}
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
