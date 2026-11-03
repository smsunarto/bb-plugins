import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarControlButton, SidebarRowControls } from "../rows/SidebarRowControls.js";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "@/components/ui/sidebar-row-classes";
import { SidebarHeaderMenuContents } from "./SidebarViewItems.js";

const MENU_SIDE_OFFSET = 8;

/** How far the menu trigger sits in from its row's controls edge. */
function controlsAfter(trigger: HTMLElement | null): number {
  const controls = trigger?.closest("[data-sidebar-row-controls]");
  if (!trigger || !controls) return 0;
  return Math.max(
    0,
    controls.getBoundingClientRect().right - trigger.getBoundingClientRect().right,
  );
}

export function SidebarHeaderControls({
  label,
  onNewThread,
  showNewThread = true,
  newThreadLast = false,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  label: string;
  onNewThread?: () => void;
  showNewThread?: boolean;
  /** A shelf puts its menu first and New thread at the edge. */
  newThreadLast?: boolean;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const compact = useIsCompactViewport();
  const [page, setPage] = useState<"organize" | "sort" | "filter" | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The menu opens past the row's edge, clear of a New thread button after it.
  const [sideOffset, setSideOffset] = useState(MENU_SIDE_OFFSET);
  const changeOpen = (next: boolean) => {
    if (next) setSideOffset(MENU_SIDE_OFFSET + controlsAfter(trigger.current));
    else setPage(null);
    onOpenChange?.(next);
  };
  return (
    <SidebarRowControls
      primaryLast={newThreadLast}
      primaryAction={
        showNewThread ? (
          <SidebarControlButton
            label={`New thread in ${label}`}
            icon="MessageSquarePlus"
            onClick={() => onNewThread?.()}
            disabled={!onNewThread}
          />
        ) : null
      }
    >
      <DropdownMenu open={open} onOpenChange={changeOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${label} actions`}
            data-sidebar-rename-anchor=""
            className={SIDEBAR_CONTROL_BUTTON_CLASS}
          >
            <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={sideOffset}
          onCloseAutoFocus={onCloseAutoFocus}
          mobileTitle={
            page === "organize"
              ? "Organize"
              : page === "sort"
                ? "Sort by"
                : page === "filter"
                  ? "Filter"
                  : `${label} actions`
          }
        >
          <SidebarHeaderMenuContents compact={compact} page={page} onPageChange={setPage}>
            {children}
          </SidebarHeaderMenuContents>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarRowControls>
  );
}
