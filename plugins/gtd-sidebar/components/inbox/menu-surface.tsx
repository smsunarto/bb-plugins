import type { KeyboardEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";

/** A desktop menu item's geometry and highlight fill; each menu adds its own text tone. */
export const MENU_ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent";

/**
 * The one material every desktop right-click menu draws on, thread rows and
 * project headers alike, so opening one after the other shows the same
 * surface: translucent, blurred, 15px corners, rimmed in the theme's border.
 */
export function MenuSurface({
  children,
  ...props
}: Omit<ContextMenu.ContextMenuContentProps, "className" | "style">) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        {...usePortalScopeProps()}
        {...props}
        className={MENU_CONTENT_CLASS}
        style={MENU_CONTENT_RESET_STYLE}
      >
        <div className={MENU_MATERIAL_CLASS}>{children}</div>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

/**
 * A submenu on the same material, for a thread action's choice list (a
 * plugin's Notifications levels, say). It hangs off its trigger row the way
 * bb's own thread menu opens one.
 */
export function MenuSubSurface({
  children,
  ...props
}: Omit<ContextMenu.ContextMenuSubContentProps, "className" | "style">) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.SubContent
        {...usePortalScopeProps()}
        sideOffset={6}
        alignOffset={-5}
        {...props}
        className={cn(MENU_CONTENT_CLASS, "max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto")}
        style={MENU_CONTENT_RESET_STYLE}
      >
        <div className={MENU_MATERIAL_CLASS}>{children}</div>
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  );
}

const MENU_CONTENT_CLASS = "z-50 min-w-44 text-popover-foreground";
// The theme paints context-menu content as an opaque, bordered 15px card.
// Inline resets outrank that selector so the blurred layer below is the only
// surface, with the theme's geometry on it.
const MENU_CONTENT_RESET_STYLE = {
  padding: 0,
  border: 0,
  background: "transparent",
  boxShadow: "none",
} as const;
const MENU_MATERIAL_CLASS = cn(
  "rounded-[15px] p-[5px]",
  // Translucent on purpose: the blurred sidebar shows through. A one-item
  // menu is too short for the blur to hide the rows behind it, so the ground
  // stays mostly opaque.
  "bg-popover/85 backdrop-blur-xl backdrop-saturate-150",
  // A 1px inner rim in the theme's border tone lifts the edge off the blur.
  // Elevation is bb's --shadow-md, as on bb's own context menus.
  "shadow-[inset_0_0_0_1px_var(--border),var(--shadow-md)]",
);

/**
 * Opens the right-click menu around the focused element on Shift+F10 or the
 * Menu key. macOS has no keyboard path to a context menu, so without this the
 * actions that live only there (pin, rename, move a project) are pointer-only.
 * The synthetic event reaches the Radix trigger the way a right-click does,
 * placed just inside the element's lower-left corner.
 *
 * Returns whether the key was taken, so a caller can skip its own handling.
 */
export function openMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  if (!((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) return false;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 12,
      clientY: rect.bottom - 4,
    }),
  );
  return true;
}
