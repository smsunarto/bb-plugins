import {
  useState,
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { ThreadMenuActions, type ThreadMenuActionsProps } from "./thread-menu-actions";

/**
 * The compact row's action menu, drawn like an iOS context menu: the rest of
 * the screen dims, the target thread row lifts in the foreground above the scrim,
 * and a frosted sheet springs out from under the pressed row, hanging from the
 * row's leading edge the way UIKit hangs it from the pressed cell.
 *
 * Controlled: a long press on the row opens it, as on iOS, and the row shows
 * no button. Radix still needs a trigger to hang the sheet from, so an
 * invisible one covers the row and takes no pointer events. Aligning to its
 * start puts the sheet on the row's left edge.
 */
const SHARED_LAYER_CLASS = cn(
  "rounded-xl",
  "border border-border-hairline",
  // bb's largest elevation token, so light and dark themes each set the depth.
  "shadow-[var(--shadow-xl)]",
);

export function CompactThreadActionMenu({
  plan,
  thread,
  rename,
  open,
  onOpenChange,
  anchorRef,
  highlightContent,
  isActive = false,
}: ThreadMenuActionsProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef?: RefObject<HTMLElement | null>;
  highlightContent?: ReactNode;
  /** The row is the open thread, so its lifted copy keeps the selected fill. */
  isActive?: boolean;
}) {
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    if (!content) return;
    const measure = () => setScrollable(content.scrollHeight > content.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    if (content.firstElementChild) observer.observe(content.firstElementChild);
    return () => observer.disconnect();
  }, [content]);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [padding, setPadding] = useState<AnchorPadding | null>(null);
  const [insets, setInsets] = useState(NO_INSETS);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef?.current;
    if (anchor) {
      setRect(anchor.getBoundingClientRect());
      // The row's padding depends on its depth and group, so the lifted copy
      // reads it rather than guessing, and draws its content where it was.
      const style = getComputedStyle(anchor);
      setPadding({
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        groupIndent: style.getPropertyValue("--gtd-group-indent"),
      });
    }
    setInsets(readSafeAreaInsets());
  }, [open, anchorRef]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 opacity-0"
        />
      </DropdownMenu.Trigger>
      <DimOverlay open={open} />
      <HighlightedThreadAnchor open={open} rect={rect} padding={padding} isActive={isActive}>
        {highlightContent}
      </HighlightedThreadAnchor>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={setContent}
          {...usePortalScopeProps()}
          aria-label="Thread actions"
          aria-labelledby={undefined}
          onCloseAutoFocus={rename.onCloseAutoFocus}
          side="top"
          align="start"
          sideOffset={6}
          // Clear of the status bar, notch and home indicator as well as the
          // screen edge, so a Dynamic Island cannot cover the first items.
          collisionPadding={{
            top: 12 + insets.top,
            bottom: 12 + insets.bottom,
            left: 12 + insets.left,
            right: 12 + insets.right,
          }}
          // As wide as the row, wider when a label needs it, never off screen.
          style={{
            maxHeight: "var(--radix-dropdown-menu-content-available-height)",
            minWidth: rect ? `${rect.width}px` : "var(--radix-dropdown-menu-trigger-width)",
            maxWidth: "var(--radix-dropdown-menu-content-available-width)",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            "group/sheet relative isolate z-50 overflow-x-hidden overflow-y-auto text-popover-foreground",
            SHARED_LAYER_CLASS,
            "origin-[var(--radix-dropdown-menu-content-transform-origin)] will-change-transform",
            // UIKit's context-menu spring: a fast rise with a small overshoot.
            "data-[state=open]:animate-[gtd-sheet-in_280ms_cubic-bezier(0.32,1.25,0.4,1)_both]",
            "data-[state=closed]:animate-[gtd-sheet-out_150ms_ease-in_both]",
          )}
        >
          <div
            className={cn(
              "relative rounded-[11px] py-1",
              // Translucent over a saturated blur, like a UIKit menu material.
              // 24px holds up across the 280ms rise on mobile Safari; the
              // scrim below already softens the list.
              "bg-popover/70 backdrop-blur-xl backdrop-saturate-150",
              "group-data-[state=open]/sheet:animate-[gtd-sheet-fade-in_180ms_ease-out_both]",
              "group-data-[state=closed]/sheet:animate-[gtd-sheet-fade-out_150ms_ease-in_both]",
            )}
          >
            <ThreadMenuActions
              thread={thread}
              plan={plan}
              rename={rename}
              compact
              haptics={!scrollable}
              closeMenu={() => onOpenChange(false)}
            />
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** The pressed row's resolved padding, and the group indent its chevron sits by. */
interface AnchorPadding {
  paddingLeft: string;
  paddingRight: string;
  groupIndent: string;
}

/**
 * The viewport's safe-area insets in px. Only CSS can read `env()`, so a
 * hidden probe pads itself by each inset and reports what it resolved to.
 */
function readSafeAreaInsets(): typeof NO_INSETS {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const insets = {
    top: px(style.paddingTop),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
    right: px(style.paddingRight),
  };
  probe.remove();
  return insets;
}

/**
 * The scrim behind an iOS context menu. Radix has no overlay for a dropdown
 * and its portal accepts a single child, so this rides its own portal and
 * outlives `open` by one fade so it can leave with the sheet. It never takes
 * pointer events: the menu already closes on any press outside itself.
 */
function DimOverlay({ open }: { open: boolean }) {
  const scope = usePortalScopeProps();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;

  return createPortal(
    <div
      {...scope}
      aria-hidden
      data-state={open ? "open" : "closed"}
      onAnimationEnd={() => {
        if (!open) setMounted(false);
      }}
      className={cn(
        "pointer-events-none fixed inset-0 z-[49] bg-black/30 backdrop-blur-[8px]",
        "data-[state=open]:animate-[gtd-dim-in_200ms_ease-out_both]",
        "data-[state=closed]:animate-[gtd-dim-out_150ms_ease-in_both]",
      )}
    />,
    document.body,
  );
}

/**
 * Portaled highlight for the target thread row when the menu is active.
 * Lifts the selected thread above the scrim at z-[50], anchoring the menu
 * visually to the specific thread that was pressed.
 */
function HighlightedThreadAnchor({
  open,
  rect,
  padding,
  isActive,
  children,
}: {
  open: boolean;
  rect?: DOMRect | null;
  padding: AnchorPadding | null;
  isActive: boolean;
  children?: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const [mounted, setMounted] = useState(open);

  if (open && !mounted) setMounted(true);
  if (!mounted || !rect || !children) return null;
  // The row's own fill, pressed or selected for the open thread, over the
  // sidebar it sits on: the copy floats above the scrim, and a translucent
  // fill alone would take the scrim's shade.
  const fill = isActive ? "var(--state-active)" : "var(--sidebar-accent)";

  return createPortal(
    <div
      {...scope}
      aria-hidden="true"
      data-state={open ? "open" : "closed"}
      onAnimationEnd={() => {
        if (!open) setMounted(false);
      }}
      style={{
        position: "fixed",
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        background: `linear-gradient(${fill}, ${fill}), var(--sidebar)`,
      }}
      className={cn(
        "pointer-events-none fixed z-50 overflow-hidden",
        SHARED_LAYER_CLASS,
        "data-[state=open]:animate-[gtd-highlight-in_200ms_ease-out_both]",
        "data-[state=closed]:animate-[gtd-highlight-out_150ms_ease-in_both]",
      )}
    >
      {/* Out over the 1px border, so the content box is the row's own box
         and nothing inside shifts as the row lifts. */}
      <div
        className="absolute -inset-px"
        style={
          {
            paddingLeft: padding?.paddingLeft,
            paddingRight: padding?.paddingRight,
            "--gtd-group-indent": padding?.groupIndent,
          } as CSSProperties
        }
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
