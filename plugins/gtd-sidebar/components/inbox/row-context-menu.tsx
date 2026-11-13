import type { RefObject } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { MenuSurface } from "./menu-surface";
import { ThreadContextMenuItems } from "./thread-menu-actions";
import { useThreadRename } from "./inline-rename";
import type { RowMenuTarget } from "./row-menu";

/**
 * The desktop menu for whichever row was right-clicked: the GTD lifecycle
 * moves, then bb's thread actions.
 *
 * One menu serves the list. Radix opens a context menu only from its own
 * trigger, so the list forwards a row's `contextmenu` to the hidden trigger
 * here (`openRowContextMenu`); the menu still opens at the pointer, which is
 * all Radix reads from the event.
 */
export function RowContextMenu({
  target,
  triggerRef,
  onOpenChange,
}: {
  /** The row the menu is for; null before the first right-click. */
  target: RowMenuTarget | null;
  triggerRef: RefObject<HTMLSpanElement | null>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ContextMenu.Root onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild>
        <span ref={triggerRef} hidden />
      </ContextMenu.Trigger>
      {target === null ? null : <RowContextMenuSurface target={target} />}
    </ContextMenu.Root>
  );
}

function RowContextMenuSurface({ target }: { target: RowMenuTarget }) {
  // The row draws the editor; this instance only starts it, once the menu
  // has handed focus back.
  const rename = useThreadRename(target.thread.id, target.thread.displayTitle);
  return (
    <MenuSurface aria-label="Thread actions" onCloseAutoFocus={rename.onCloseAutoFocus}>
      <ThreadContextMenuItems
        thread={target.thread}
        plan={target.plan}
        requestRename={() => rename.startEditingFromMenu()}
      />
    </MenuSurface>
  );
}

/** Opens the shared menu at a point, the way a right-click on its trigger would. */
export function openRowContextMenu(trigger: HTMLElement | null, x: number, y: number): void {
  trigger?.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}
