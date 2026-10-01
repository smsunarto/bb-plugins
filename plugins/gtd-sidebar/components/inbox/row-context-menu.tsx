import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Glass } from "@samasante/liquid-glass";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { MENU_GLASS } from "../../lib/menu-glass";
import type { DispatchRowCommand, ThreadActionPlan } from "./thread-actions";
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
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...usePortalScopeProps()}
          aria-label="Thread actions"
          onCloseAutoFocus={rename.onCloseAutoFocus}
          className="z-50 min-w-44 text-popover-foreground"
          // The theme paints context-menu content as an opaque, bordered
          // 15px card. Inline resets outrank that selector so the Glass
          // below is the only surface, with the theme's geometry moved onto it.
          style={{ padding: 0, border: 0, background: "transparent", boxShadow: "none" }}
        >
          <Glass
            optics={MENU_GLASS}
            style={{ display: "block" }}
            className={cn(
              "rounded-[15px] p-[5px]",
              // Translucent on purpose: the colour is the glass tint and the
              // refracted sidebar shows through it.
              "bg-popover/70",
              // Uniform 1px rim so all four edges read alike (see MENU_GLASS).
              "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12),0_0_0_0.5px_rgba(0,0,0,0.18),0_16px_40px_rgba(0,0,0,0.26),0_2px_6px_rgba(0,0,0,0.18)]",
            )}
          >
            <ThreadMenuActions
              thread={thread}
              command={command}
              plan={plan}
              rename={rename}
              canSplit={canSplit}
            />
          </Glass>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
