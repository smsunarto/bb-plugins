import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { DispatchRowCommand, ThreadActionPlan } from "./thread-actions";
import { MenuSurface } from "./menu-surface";
import { ThreadMenuActions } from "./thread-menu-actions";
import type { ThreadRename } from "./inline-rename";

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
  rename,
  canSplit,
  disabled = false,
  children,
}: {
  thread: PluginSidebarThread;
  command: DispatchRowCommand;
  plan: ThreadActionPlan;
  /** The row's in-place title editor, which Rename opens. */
  rename: ThreadRename;
  canSplit: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={disabled}>
        {children}
      </ContextMenu.Trigger>
      <MenuSurface aria-label="Thread actions" onCloseAutoFocus={rename.onCloseAutoFocus}>
        <ThreadMenuActions
          thread={thread}
          command={command}
          plan={plan}
          rename={rename}
          canSplit={canSplit}
        />
      </MenuSurface>
    </ContextMenu.Root>
  );
}
