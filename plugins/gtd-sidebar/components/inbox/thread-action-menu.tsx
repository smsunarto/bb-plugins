import { useState, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { attachHapticTrigger } from "@/lib/ios-haptics";
import {
  getThreadActionGroups,
  type ThreadAction,
  type ThreadActionPlan,
} from "@/components/inbox/thread-actions";

/** iOS menus lead each row with a glyph; SF Symbols stand in as Hugeicons. */
function actionIcon(action: ThreadAction): IconName {
  switch (action.id) {
    case "open-in-split":
      return "SidebarRight";
    case "snooze-tomorrow":
      return "Clock";
    case "settle":
      return "Check";
    case "wake-now":
      return "AlarmClock";
    case "unsettle":
      return "ArrowTurnBackward";
    case "rename-thread":
      return "Sparkles";
    case "toggle-read":
      return action.label === "Mark read" ? "MailOpen" : "Mail";
    case "toggle-pin":
      return action.label === "Unpin" ? "PinOff" : "Pin";
    case "archive":
      return "Archive";
    case "request-delete":
      return "Delete";
  }
}

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
  "border border-black/10 dark:border-white/10",
  "shadow-[0_12px_36px_rgba(0,0,0,0.3)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.55)]",
);

export function CompactThreadActionMenu({
  plan,
  open,
  onOpenChange,
  anchorRef,
  highlightContent,
}: {
  plan: ThreadActionPlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef?: RefObject<HTMLElement | null>;
  highlightContent?: ReactNode;
}) {
  const groups = getThreadActionGroups(plan);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (open && anchorRef?.current) {
      setRect(anchorRef.current.getBoundingClientRect());
    }
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
      <HighlightedThreadAnchor open={open} rect={rect}>
        {highlightContent}
      </HighlightedThreadAnchor>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...usePortalScopeProps()}
          aria-label="Thread actions"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          style={{
            width: rect ? `${rect.width}px` : "var(--radix-dropdown-menu-trigger-width)",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            "group/sheet relative isolate z-50 overflow-hidden text-popover-foreground",
            SHARED_LAYER_CLASS,
            "backdrop-blur-xl backdrop-saturate-[1.8] bg-white/75 dark:bg-[#1c1c1e]/80",
            "origin-[var(--radix-dropdown-menu-content-transform-origin)] will-change-transform",
            // UIKit's context-menu spring: a fast rise with a small overshoot.
            "data-[state=open]:animate-[gtd-sheet-in_280ms_cubic-bezier(0.32,1.25,0.4,1)_both]",
            "data-[state=closed]:animate-[gtd-sheet-out_150ms_ease-in_both]",
          )}
        >
          <div
            className={cn(
              "relative py-1",
              "group-data-[state=open]/sheet:animate-[gtd-sheet-fade-in_180ms_ease-out_both]",
              "group-data-[state=closed]/sheet:animate-[gtd-sheet-fade-out_150ms_ease-in_both]",
            )}
          >
            {groups.map((group) => (
              <div key={group.id}>
                {group.actions.map((action) => (
                  <DropdownMenu.Item
                    key={action.id}
                    ref={attachHapticTrigger}
                    onSelect={action.execute}
                    className={cn(
                      "relative flex h-[44px] cursor-default select-none items-center gap-3.5 px-4 text-[16px] font-normal leading-none tracking-[-0.01em] outline-none",
                      "data-[highlighted]:bg-black/[0.06] dark:data-[highlighted]:bg-white/10",
                      action.id === "request-delete" ? "text-[#ff453a]" : "text-popover-foreground",
                    )}
                  >
                    <Icon name={actionIcon(action)} className="size-[20px] shrink-0" />
                    <span className="truncate">{action.label}</span>
                  </DropdownMenu.Item>
                ))}
              </div>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
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
  children,
}: {
  open: boolean;
  rect?: DOMRect | null;
  children?: ReactNode;
}) {
  const scope = usePortalScopeProps();
  const [mounted, setMounted] = useState(open);

  if (open && !mounted) setMounted(true);
  if (!mounted || !rect || !children) return null;

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
      }}
      className={cn(
        "pointer-events-none fixed z-50 overflow-hidden",
        SHARED_LAYER_CLASS,
        "bg-sidebar-accent",
        "data-[state=open]:animate-[gtd-highlight-in_200ms_ease-out_both]",
        "data-[state=closed]:animate-[gtd-highlight-out_150ms_ease-in_both]",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
