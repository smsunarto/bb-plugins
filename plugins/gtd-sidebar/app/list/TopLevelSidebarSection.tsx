import {
  useCallback,
  useId,
  type CSSProperties,
  type KeyboardEventHandler,
  type MouseEvent,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { CHROME_SECTION_LABEL_CLASS } from "@/components/ui/chrome-style-tokens";
import { SidebarStickyGroup, SidebarStickyTier } from "../ui/sidebar.js";
import {
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
  SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
} from "@/components/ui/sidebar-hover-actions";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import {
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import {
  SectionDropTargetOverlay,
  useSectionDropTargetState,
} from "../dnd/useSectionDropTargetState.js";
import type { SidebarSortableDragBindings } from "@/components/ui/sortable-motion";
import {
  NO_COLLAPSED_CHILD_ACTIVITY,
  type CollapsedChildActivity,
} from "../model/thread-activity.js";
import { CollapsedThreadStatusGlyph } from "../rows/ThreadRow.js";
import {
  useThreadGroupSplitIndicator,
  type ThreadSplitIndicatorTarget,
  usePluginThreadRowStatusForThreads,
} from "./groupRollups.js";
import { SplitPaneMiniMap } from "@/components/ui/split-pane-mini-map";
import { SlidingDisclosure } from "../ui/SlidingDisclosure.js";
import { spokenFoldCount, type FoldCount } from "../gtd/fold-count.js";
import {
  COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
  COARSE_POINTER_GLYPH_BOX_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
} from "@/components/ui/coarse-pointer-sizing";

import { useGtdRowContextVisible } from "../gtd/row-extras.js";

const EMPTY_SPLIT_INDICATOR_THREADS: readonly ThreadSplitIndicatorTarget[] = [];

function stopActionsClick(event: MouseEvent<HTMLSpanElement>) {
  event.stopPropagation();
}

interface TopLevelSidebarSectionCollapseControl {
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

export interface TopLevelSidebarSectionProps {
  label: string;
  /**
   * GTD: "label" is a section label (a shelf). "project" is a group row
   * inside one, drawn like bb's worktree group row and pinned on the sticky
   * project tier under its shelf's label.
   */
  tier?: "label" | "project";
  /** The group row's leading icon; "project" tier only. */
  icon?: string;
  /**
   * A folded group's footprint, shown at its right edge as GTD's folders
   * did: `needs you / families`, or the families alone. "project" tier only.
   */
  foldCount?: FoldCount;
  labelEditor?: ReactNode;
  onRename?: () => void;
  children: ReactNode;
  dropParentKey?: string;
  sectionId?: string;
  stickyHeader?: boolean;
  status?: ReactNode;
  actions?: ReactNode;
  actionsAlwaysVisible?: boolean;
  actionsMobileAlways?: boolean;
  actionsOpen?: boolean;
  collapseControl?: TopLevelSidebarSectionCollapseControl;
  collapsedActivity?: CollapsedChildActivity;
  collapsedThreads?: readonly ThreadSplitIndicatorTarget[];
  dragBindings?: SidebarSortableDragBindings;
  sectionRef?: (element: HTMLDivElement | null) => void;
  sectionStyle?: CSSProperties;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  isDropTargetActive?: boolean;
}

export function TopLevelSidebarSection({
  label,
  tier = "label",
  icon,
  foldCount: suppliedFoldCount,
  labelEditor,
  onRename,
  children,
  dropParentKey,
  sectionId,
  stickyHeader = true,
  status,
  actions,
  actionsAlwaysVisible = false,
  actionsMobileAlways = false,
  actionsOpen = false,
  collapseControl,
  collapsedActivity,
  collapsedThreads = EMPTY_SPLIT_INDICATOR_THREADS,
  dragBindings,
  sectionRef,
  sectionStyle,
  consumeClickSuppression,
  isDropTargetActive = false,
}: TopLevelSidebarSectionProps) {
  const rowContextVisible = useGtdRowContextVisible();
  const showContext = tier === "label" || rowContextVisible;
  const foldCount = showContext ? suppliedFoldCount : undefined;
  const threadDropState = useSectionDropTargetState(dropParentKey);
  const collapsedSplitIndicator = useThreadGroupSplitIndicator(
    collapsedThreads,
    collapseControl?.isCollapsed === true,
  );
  const pluginStatus = usePluginThreadRowStatusForThreads(collapsedThreads);
  const isFolder = tier === "project";
  const isCollapsed = collapseControl?.isCollapsed === true;
  const showFoldCount =
    isFolder && isCollapsed && foldCount !== undefined && foldCount.families > 0 && !status;
  const showCollapsedActivity =
    showContext &&
    !status &&
    collapseControl?.isCollapsed === true &&
    (collapsedSplitIndicator.miniMap !== null ||
      collapsedActivity !== undefined ||
      pluginStatus !== null);
  const collapsedActivityIndicator = showCollapsedActivity ? (
    <span
      data-sidebar-collapsed-activity-edge=""
      data-sidebar-hover-actions-open={actionsOpen ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute right-0 top-1/2 z-20 inline-flex -translate-y-1/2 items-center justify-center text-subtle-foreground max-md:static max-md:shrink-0 max-md:translate-y-0",
        COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
        actions && SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
      )}
    >
      {collapsedSplitIndicator.miniMap ? (
        <SplitPaneMiniMap
          slots={collapsedSplitIndicator.miniMap}
          label={`${label} — contains a thread open in split`}
          isWorking={collapsedActivity?.working || pluginStatus?.tone === "running"}
        />
      ) : collapsedActivity || pluginStatus ? (
        <CollapsedThreadStatusGlyph
          activity={collapsedActivity ?? NO_COLLAPSED_CHILD_ACTIVITY}
          pluginStatus={pluginStatus}
        />
      ) : null}
    </span>
  ) : null;
  // GTD's folded count sits beside bb's collapsed activity, which keeps the
  // split mini map, work, drafts, and plugin status the count leaves out.
  const foldCountIndicator = showFoldCount ? (
    <span
      data-gtd-fold-count=""
      data-sidebar-hover-actions-open={actionsOpen ? "true" : undefined}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-1/2 z-20 -translate-y-1/2 whitespace-nowrap text-[10px] font-medium tabular-nums max-md:static max-md:mr-2 max-md:translate-y-0",
        showCollapsedActivity ? "right-8 max-md:pointer-coarse:right-10" : "right-2",
        foldCount.attention > 0 ? "text-attention" : "text-muted-foreground",
        actions && SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
      )}
    >
      {foldCount.attention > 0
        ? `${foldCount.attention} / ${foldCount.families}`
        : `${foldCount.families}`}
    </span>
  ) : null;
  const handleFolderClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-trailing-controls]")
      )
        return;
      collapseControl?.onToggleCollapsed();
    },
    [collapseControl],
  );
  const handleClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (labelEditor || !consumeClickSuppression?.()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeClickSuppression, labelEditor],
  );
  const handleCollapseControlClick = useCallback<MouseEventHandler<HTMLButtonElement>>(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      collapseControl?.onToggleCollapsed();
    },
    [collapseControl],
  );
  const stopCollapseControlPointerDown = useCallback<PointerEventHandler<HTMLButtonElement>>(
    (event) => {
      event.stopPropagation();
    },
    [],
  );
  const stopCollapseControlKeyDown = useCallback<KeyboardEventHandler<HTMLButtonElement>>(
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.stopPropagation();
      }
    },
    [],
  );

  return (
    <SidebarStickyGroup
      ref={sectionRef}
      style={sectionStyle}
      data-sidebar-section-id={sectionId}
      data-sidebar-drop-target={threadDropState ?? undefined}
      data-sidebar-rename-row=""
      data-sidebar-sticky-header={stickyHeader ? undefined : "false"}
      className={cn(
        "group/sidebar-section relative min-w-0 rounded-md transition-colors",
        isDropTargetActive && "bg-sidebar-accent/60",
      )}
      onClickCapture={handleClickCapture}
    >
      {threadDropState ? <SectionDropTargetOverlay state={threadDropState} /> : null}
      <SidebarStickyTier
        ref={dragBindings?.setActivatorNodeRef}
        tier={tier}
        data-gtd-folder={isFolder ? "" : undefined}
        className={cn(
          SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
          isFolder
            ? [
                "gtd-folder-header flex w-full items-center rounded-md pr-0",
                // bb's sticky tiers place the rows below on this height.
                COARSE_POINTER_COMPACT_ROW_HEIGHT_CLASS,
                collapseControl && !labelEditor && "cursor-pointer",
              ]
            : [
                CHROME_SECTION_LABEL_CLASS,
                "gtd-shelf-header",
                SIDEBAR_STANDARD_ROW_PADDING_CLASS,
                SIDEBAR_GROUP_TEXT_CLASS,
                "rounded-md pr-0 transition-colors",
              ],
          !stickyHeader && "relative top-auto",
          dragBindings && !dragBindings.disabled && "select-none",
        )}
        onClick={isFolder && collapseControl && !labelEditor ? handleFolderClick : undefined}
        {...dragBindings?.attributes}
        {...(dragBindings?.listeners ?? {})}
      >
        {isFolder ? (
          <FolderGlyph
            icon={icon ?? "Folder"}
            label={label}
            collapseControl={collapseControl}
            foldCount={foldCount}
            disabled={Boolean(labelEditor)}
            onClick={handleCollapseControlClick}
            onPointerDown={stopCollapseControlPointerDown}
            onKeyDown={stopCollapseControlKeyDown}
          />
        ) : null}
        <span
          className={cn(
            "relative z-10 flex min-w-0 flex-1 items-center text-left",
            isFolder ? "gtd-folder-name" : "flex-initial gap-1",
          )}
        >
          {labelEditor ??
            (collapseControl && !isFolder ? (
              // A shelf folds from its label: bb's header, without the chevron.
              <button
                type="button"
                data-sidebar-rename-anchor=""
                aria-expanded={!collapseControl.isCollapsed}
                aria-label={
                  collapseControl.isCollapsed
                    ? `Expand ${label} section`
                    : `Collapse ${label} section`
                }
                title={label}
                className="gtd-shelf-toggle min-w-0 cursor-pointer truncate rounded-sm text-left outline-none ring-sidebar-ring focus-visible:ring-2"
                onClick={handleCollapseControlClick}
                onKeyDown={stopCollapseControlKeyDown}
              >
                {label}
              </button>
            ) : (
              <span
                className="min-w-0 truncate"
                title={label}
                onDoubleClick={
                  // A folder toggles on a click, so its double-click would fold
                  // twice; folders rename from their menus.
                  onRename && !isFolder
                    ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRename();
                      }
                    : undefined
                }
              >
                {label}
              </span>
            ))}
        </span>
        {!isFolder ? <span aria-hidden="true" className="gtd-shelf-rule" /> : null}
        {status || actions || collapsedActivityIndicator || foldCountIndicator ? (
          <span
            data-sidebar-trailing-controls=""
            className={cn(
              "relative z-20 inline-flex h-7 shrink-0 items-center max-md:pointer-coarse:h-9",
              labelEditor && "hidden",
              SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
            )}
            onClick={status || actions ? stopActionsClick : undefined}
          >
            {status}
            {foldCountIndicator}
            {collapsedActivityIndicator}
            {actions ? (
              <span
                data-sidebar-hover-actions-open={actionsOpen ? "true" : undefined}
                data-sidebar-hover-actions-mobile={
                  actionsMobileAlways ? SIDEBAR_HOVER_ACTIONS_MOBILE_ALWAYS_VALUE : undefined
                }
                className={cn(
                  "inline-flex shrink-0 items-center",
                  SIDEBAR_HOVER_ACTIONS_GAP_CLASS,
                  !actionsAlwaysVisible && SIDEBAR_HOVER_ACTIONS_CLASS,
                  collapseControl?.isCollapsed && "[@media(hover:none)]:hidden",
                )}
              >
                {actions}
              </span>
            ) : null}
          </span>
        ) : null}
      </SidebarStickyTier>
      {children == null ? null : (
        <SlidingDisclosure open={!isCollapsed}>
          {isFolder ? (
            <div data-gtd-group-content="">{children}</div>
          ) : (
            <div className="mt-1">{children}</div>
          )}
        </SlidingDisclosure>
      )}
    </SidebarStickyGroup>
  );
}

/**
 * A folder's leading glyph in the tree's 24px disclosure column: its icon at
 * rest, the fold chevron while the header is hovered or the toggle has
 * keyboard focus (shelves.css), as GTD's own folders drew it.
 */
function FolderGlyph({
  icon,
  label,
  collapseControl,
  foldCount,
  disabled,
  onClick,
  onPointerDown,
  onKeyDown,
}: {
  icon: string;
  label: string;
  collapseControl?: TopLevelSidebarSectionCollapseControl;
  foldCount?: FoldCount;
  disabled: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}) {
  const descriptionId = useId();
  const glyphs = (
    <>
      <Icon
        name={icon}
        className="gtd-folder-icon size-3 max-md:pointer-coarse:size-4"
        aria-hidden="true"
      />
      {collapseControl ? (
        <Icon
          name="ChevronDown"
          className={cn(
            "gtd-folder-chevron gtd-chevron-motion size-3 max-md:pointer-coarse:size-4",
            collapseControl.isCollapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  if (!collapseControl) {
    return (
      <span className="gtd-folder-glyph" aria-hidden="true">
        {glyphs}
      </span>
    );
  }
  const folded = collapseControl.isCollapsed;
  const spoken = folded && foldCount ? spokenFoldCount(foldCount) : null;
  return (
    <button
      type="button"
      disabled={disabled}
      data-sidebar-rename-anchor=""
      aria-expanded={!folded}
      aria-label={folded ? `Expand ${label} section` : `Collapse ${label} section`}
      aria-describedby={spoken === null ? undefined : descriptionId}
      className="gtd-folder-glyph"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      {glyphs}
      {spoken === null ? null : (
        <span id={descriptionId} className="sr-only">
          {spoken}
        </span>
      )}
    </button>
  );
}
