import { SlidingDisclosure } from "./sliding-disclosure";
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon } from "../ui/icon";
import { cn } from "../../lib/utils";
import { FadingText } from "./thread-details";
import { MENU_ITEM_CLASS, MenuSurface, openMenuFromKeyboard } from "./menu-surface";
import { useNestProjectHeader } from "../../hooks/use-nest-drag";
import { DRAG_KIND } from "../../lib/sidebar-drag";
import type { InboxShelf } from "../../lib/inbox-tree";
import type { HeaderMeasureProps } from "../../hooks/use-inbox-window";

/**
 * A project group wired into its shelf's sortable list: the header is the
 * drag handle and the whole group — folded or not — is the item that moves.
 * `data.kind` marks the payload "project", so the shared drag context's drop
 * resolver routes it to the reorder path and it can never read as a thread.
 */
export function SortableProjectGroup(props: ProjectGroupProps) {
  const sortable = useSortable({ id: props.projectId, data: { kind: DRAG_KIND.project } });
  return <ProjectGroup {...props} sortable={sortable} />;
}

/**
 * One project inside a shelf: a header naming the project, then its rows.
 *
 * The shelf still answers the larger question (can the user act?), so the
 * header carries only the project name. The count shows while the group is
 * folded, where it is the group's whole footprint: `needs-you / total` when
 * something in it asks for the user, the total alone otherwise. Hovering the
 * header trades the count for a new-thread button. Compact viewports keep
 * both the count and the new-thread button visible for touch access.
 *
 * Right-clicking the header offers "Move up" / "Move down", and a sortable
 * group drags by its header — both reorder the project in bb's own order,
 * the same order every shelf groups by, so the move lands identically under
 * each shelf. The menu, opened by Shift+F10 or the Menu key, stays as the
 * keyboard path: the sortable handle is pointer-only.
 *
 * The header is also the drop target that lifts a nested row back to the top
 * level of its project (see use-nest-drag), lit while a row that may drop
 * there is over it.
 */
export function ProjectGroup({
  projectId,
  shelf,
  name,
  families,
  attention,
  expanded,
  onToggle,
  onNewThread,
  onMoveUp,
  onMoveDown,
  isCompactViewport,
  dropAllowed,
  sortable,
  measureRef,
  measureIndex,
  children,
}: ProjectGroupProps) {
  const drop = useNestProjectHeader(shelf, projectId, dropAllowed);
  const { setDropRef } = drop;
  const setHeaderRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDropRef(element);
      measureRef(element);
    },
    [setDropRef, measureRef],
  );
  const [hovered, setHovered] = useState(false);
  // Reaching the new-thread button by keyboard trades the count for it, as
  // hovering the header does.
  const [newFocusVisible, setNewFocusVisible] = useState(false);
  // Keyboard focus on the toggle shows the fold chevron, as hovering does.
  const [toggleFocusVisible, setToggleFocusVisible] = useState(false);
  const showChevron = hovered || toggleFocusVisible;
  const count = attention > 0 ? `${attention} / ${families}` : `${families}`;
  const header = (
    <div
      ref={setHeaderRef}
      data-index={measureIndex}
      className={cn(
        "gtd-project-group-header group/pg",
        isCompactViewport && "gtd-project-group-header-touch",
      )}
      data-drop-target={drop.isOver ? "true" : undefined}
      data-new-focus-visible={newFocusVisible}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      // The pointer activator only: the sortable keeps keyboard reorder to the
      // context menu's Move up/down, and a bubbled Space on the toggle must
      // stay a toggle.
      onPointerDown={(event) => sortable?.listeners?.onPointerDown?.(event)}
    >
      <button
        type="button"
        onClick={onToggle}
        onFocus={(event) => setToggleFocusVisible(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => setToggleFocusVisible(false)}
        onKeyDown={(event) => {
          if (onMoveUp !== undefined || onMoveDown !== undefined) openMenuFromKeyboard(event);
        }}
        aria-expanded={expanded}
        aria-label={`${name} project${expanded ? "" : `, ${spokenCount(families, attention)}`}`}
        className="gtd-project-group-toggle"
      >
        <span className="gtd-disclosure gtd-project-group-chevron">
          <Icon
            key={showChevron ? "chevron" : "folder"}
            name={showChevron ? "ChevronDown" : "Folder"}
            className={cn(
              "gtd-chevron-motion",
              isCompactViewport ? "size-4" : "size-3",
              showChevron && !expanded && "-rotate-90",
            )}
          />
        </span>
        <FadingText text={name} className="gtd-project-group-name" />
        {expanded ? null : (
          <span
            className={cn("gtd-project-group-count", attention > 0 && "gtd-project-group-attn")}
          >
            {count}
          </span>
        )}
      </button>
      <NewThreadButton
        name={name}
        onClick={() => onNewThread(projectId)}
        onFocusVisibleChange={setNewFocusVisible}
      />
    </div>
  );
  return (
    <div
      ref={sortable?.setNodeRef}
      className="gtd-project-group"
      data-project-id={projectId}
      data-dragging={sortable?.isDragging || undefined}
      style={sortableStyle(sortable)}
    >
      {onMoveUp === undefined && onMoveDown === undefined ? (
        header
      ) : (
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <MenuSurface aria-label={`${name} project actions`}>
            {onMoveUp === undefined ? null : (
              <ContextMenu.Item
                onSelect={onMoveUp}
                className={cn(MENU_ITEM_CLASS, "data-[highlighted]:text-accent-foreground")}
              >
                <Icon name="ChevronUp" className="size-4 shrink-0" />
                Move up
              </ContextMenu.Item>
            )}
            {onMoveDown === undefined ? null : (
              <ContextMenu.Item
                onSelect={onMoveDown}
                className={cn(MENU_ITEM_CLASS, "data-[highlighted]:text-accent-foreground")}
              >
                <Icon name="ChevronDown" className="size-4 shrink-0" />
                Move down
              </ContextMenu.Item>
            )}
          </MenuSurface>
        </ContextMenu.Root>
      )}
      <SlidingDisclosure open={expanded}>
        <ul className="gtd-project-group-rows flex flex-col">{children}</ul>
      </SlidingDisclosure>
    </div>
  );
}

/** The folded count in words: a screen reader reads the visible `2 / 5` as "2 slash 5". */
function spokenCount(families: number, attention: number) {
  const threads = `${families} ${families === 1 ? "thread" : "threads"}`;
  if (attention <= 0) return threads;
  return `${threads}, ${attention} ${attention === 1 ? "needs" : "need"} you`;
}

/** The header's new-thread button, reporting keyboard focus so the header can hide its count. */
function NewThreadButton({
  name,
  onClick,
  onFocusVisibleChange,
}: {
  name: string;
  onClick: () => void;
  onFocusVisibleChange: (focusVisible: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`New thread in ${name}`}
      title={`New thread in ${name}`}
      onClick={onClick}
      onFocus={(event) => onFocusVisibleChange(event.currentTarget.matches(":focus-visible"))}
      onBlur={() => onFocusVisibleChange(false)}
      className="gtd-project-group-new"
    >
      <Icon name="Plus" className="size-3" />
    </button>
  );
}

export interface ProjectGroupProps extends HeaderMeasureProps {
  projectId: string;
  shelf: InboxShelf;
  name: string;
  families: number;
  attention: number;
  expanded: boolean;
  onToggle: () => void;
  onNewThread: (projectId: string) => void;
  /** Move handlers, absent where the move cannot run (edge groups, personal). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isCompactViewport: boolean;
  /** Whether the row being dragged may lift to this project's top level. */
  dropAllowed: boolean;
  /** The group's sortable wiring; absent on groups bb will not reorder. */
  sortable?: ReturnType<typeof useSortable>;
  children: ReactNode;
}

function sortableStyle(sortable: ProjectGroupProps["sortable"]): CSSProperties | undefined {
  if (sortable === undefined) return undefined;
  return {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
}
