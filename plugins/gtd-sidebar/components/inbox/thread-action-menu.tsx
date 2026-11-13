import { useCallback, useState, type CSSProperties } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { getMediaQuerySnapshot, REDUCED_MOTION_QUERY } from "../ui/hooks/use-media-query";
import { useThreadRename } from "./inline-rename";
import type { RowMenuTarget } from "./row-menu";
import { moveSheetFocus, ThreadSheetMenu } from "./thread-menu-actions";

/** Where the pressed row sat when the sheet opened, and a picture of it. */
export interface SheetOrigin {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The layout viewport's height, which the layer below fills. */
  viewportHeight: number;
  /** The row's own DOM, copied as the press landed. */
  lift: HTMLElement;
  /** The custom properties the row's padding resolves against in its group. */
  groupIndent: string;
  leafGroupIndent: string;
}

/**
 * Photographs a row for the sheet: its box, and a copy of its DOM with
 * everything that identifies or activates it removed. A copy rather than a
 * second render, so the lifted row is the pressed row to the pixel — status,
 * other plugins' badges and all — with nothing to keep in step.
 */
export function captureSheetOrigin(row: HTMLElement): SheetOrigin {
  const rect = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  const lift = row.cloneNode(true) as HTMLElement;
  for (const element of [lift, ...lift.querySelectorAll<HTMLElement>("*")]) {
    // The row's link is an overlay with nothing to draw. Left in, bb's thread
    // keys would find the thread twice.
    if (element.tagName === "A") {
      element.remove();
      continue;
    }
    element.removeAttribute("id");
    for (const name of element.getAttributeNames()) {
      if (name.startsWith("data-sidebar-") || name === "data-gtd-menu-row") {
        element.removeAttribute(name);
      }
    }
  }
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    viewportHeight: window.innerHeight,
    lift,
    groupIndent: style.getPropertyValue("--gtd-group-indent"),
    leafGroupIndent: style.getPropertyValue("--gtd-leaf-group-indent"),
  };
}

/**
 * The touch menu, drawn like an iOS context menu: the screen dims, the
 * pressed row lifts above the scrim, and a sheet of actions springs out
 * beside it — below a row in the top half of the screen, above one in the
 * bottom half.
 *
 * The layer is a flex column: a spacer as tall as the row's offset, then the
 * row and the sheet. The spacer is the only part that shrinks, so when the
 * sheet has no room the row slides toward the middle to make it, as UIKit's
 * does, and the sheet scrolls only on a screen too short to hold it at all.
 * CSS does all of it (app.css), with the safe-area insets read where they
 * are defined.
 */
export function ThreadActionSheet({
  target,
  origin,
  open,
  onOpenChange,
}: {
  target: RowMenuTarget;
  origin: SheetOrigin;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const scope = usePortalScopeProps();
  const rename = useThreadRename(target.thread.id, target.thread.displayTitle);
  const close = () => onOpenChange(false);
  const side = origin.top + origin.height / 2 > origin.viewportHeight / 2 ? "above" : "below";

  // Runs as the row and sheet mount, which Radix does a commit after `open`.
  const mountGroup = useCallback(
    (group: HTMLDivElement | null) => {
      const lift = group?.querySelector<HTMLElement>(".gtd-sheet-lift");
      if (!group || !lift) return;
      lift.replaceChildren(origin.lift);
      // Where the row had to move to make room, it travels from its place in
      // the list and takes the sheet with it.
      const moved = origin.top - lift.getBoundingClientRect().top;
      if (Math.abs(moved) < 1 || getMediaQuerySnapshot(REDUCED_MOTION_QUERY)) return;
      group.animate([{ transform: `translateY(${moved}px)` }, { transform: "none" }], {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    },
    [origin],
  );

  // The iOS haptic rides an invisible switch over each item, which swallows a
  // scroll that starts on it (lib/ios-haptics). A sheet too tall for its
  // screen, as on a phone held sideways, gives the tick up to stay scrollable.
  const [scrollable, setScrollable] = useState(false);
  const watchOverflow = useCallback((sheet: HTMLDivElement | null) => {
    if (sheet === null) return;
    const measure = () => setScrollable(sheet.scrollHeight > sheet.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    if (sheet.firstElementChild) observer.observe(sheet.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay {...scope} className="gtd-sheet-scrim" />
        <Dialog.Content
          {...scope}
          aria-describedby={undefined}
          data-side={side}
          className="gtd-sheet-layer"
          style={
            {
              "--gtd-lift-top": `${origin.top}px`,
              "--gtd-lift-bottom": `${origin.viewportHeight - origin.top - origin.height}px`,
              "--gtd-lift-left": `${origin.left}px`,
              "--gtd-lift-width": `${origin.width}px`,
              "--gtd-lift-height": `${origin.height}px`,
            } as CSSProperties
          }
          // No item starts highlighted under a finger; the layer takes
          // focus, and the arrow keys walk the items from there.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus({ preventScroll: true });
          }}
          onKeyDown={moveSheetFocus}
          onCloseAutoFocus={rename.onCloseAutoFocus}
          // The layer fills the screen, so a press anywhere but the sheet is
          // the press outside that closes it.
          onPointerDown={(event) => {
            if (!(event.target as Element).closest(".gtd-sheet")) close();
          }}
        >
          {/* Names the thread for a screen reader, which cannot see the lifted row. */}
          <Dialog.Title className="sr-only">{target.thread.displayTitle}</Dialog.Title>
          <div className="gtd-sheet-spacer" />
          <div ref={mountGroup} className="gtd-sheet-group">
            <div
              aria-hidden
              inert
              className="gtd-sheet-lift"
              style={
                {
                  "--gtd-group-indent": origin.groupIndent || undefined,
                  "--gtd-leaf-group-indent": origin.leafGroupIndent || undefined,
                } as CSSProperties
              }
            />
            <div
              ref={watchOverflow}
              // Theme tokens only: a `dark:` variant would follow the OS, not bb's theme.
              className="gtd-sheet border border-border-hairline bg-popover/80 text-popover-foreground shadow-[var(--shadow-xl)]"
            >
              <ThreadSheetMenu
                thread={target.thread}
                plan={target.plan}
                haptics={!scrollable}
                requestRename={() => rename.startEditingFromMenu(close)}
                onClose={close}
              />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
