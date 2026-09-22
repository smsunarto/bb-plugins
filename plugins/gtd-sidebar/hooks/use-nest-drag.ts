import { useMemo, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DndContextProps,
  type Modifier,
} from "@dnd-kit/core";
import { hasSortableData, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "../server";
import { useCommittedEvent } from "./use-committed-event";
import type { InboxShelf } from "../lib/inbox-tree";
import { projectDropEdge, type ProjectDropEdge } from "../lib/project-groups";
import { DRAG_KIND, sidebarDragPayload, type SidebarDragPayload } from "../lib/sidebar-drag";

/** How far the pointer travels before a press becomes a drag; a click stays a click. */
const DRAG_DISTANCE_PX = 6;

/** Droppable ids: one per thread row, one per project header per shelf. */
export function threadDropId(threadId: string): string {
  return `thread:${threadId}`;
}
export function projectDropId(shelf: InboxShelf, projectId: string): string {
  return `project:${shelf}:${projectId}`;
}

/** The drop the id names: a new parent, or null for the top level. */
function parentFromDropId(id: string): string | null | undefined {
  if (id.startsWith("thread:")) return id.slice("thread:".length);
  if (id.startsWith("project:")) return null;
  return undefined;
}

export interface SidebarDragApi {
  /** The payload the pointer is carrying, null between drags. */
  source: SidebarDragPayload | null;
}

/** A project-group drop resolved to the group it landed on and the side. */
export interface SidebarProjectDrop {
  projectId: string;
  overProjectId: string;
  edge: ProjectDropEdge;
}

/**
 * One collision rule per payload kind. A dragged thread keeps `pointerWithin`
 * over the nest targets — the groups' sortable containers are filtered out so
 * a group can never shadow the row or header under the pointer. A dragged
 * group goes by `closestCenter` over sortable items only: the `thread:` and
 * `project:` drop ids are not sortable, so a thread target can never receive
 * a group.
 */
const sidebarCollision: CollisionDetection = (args) => {
  if (args.active.data.current?.kind === DRAG_KIND.project) {
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(hasSortableData),
    });
  }
  return pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => !hasSortableData(container),
    ),
  });
};

/** A group tracks the pointer's Y only; a thread ghost follows it freely. */
const sidebarModifiers: Modifier[] = [
  ({ transform, active }) =>
    active?.data.current?.kind === DRAG_KIND.project ? { ...transform, x: 0 } : transform,
];

/**
 * The sidebar's one drag context, shared by two payloads discriminated on
 * `data.kind` (lib/sidebar-drag):
 *
 * - a thread row dragged onto another row becomes its child; dropped on a
 *   project header it goes back to the top level. The drop is bb's
 *   `threads.update({ parentThreadId })` through the backend, and the sidebar
 *   redraws off bb's thread feed, so no local reorder happens.
 * - a project group header dragged onto another header in its shelf reorders
 *   the project; `onProjectDrop` resolves the reorder against bb's full
 *   project order and writes it through `reorderProject`.
 *
 * Which thread targets may take the drop is decided by the tree
 * (`nestDropAllowed`, `unnestDropAllowed`); a refused target is a disabled
 * droppable, so dnd-kit never reports it as `over` and it never lights up.
 * Which groups sort is the shelf's `SortableContext` items — a project bb
 * refuses (the personal one, a stale id) is not among them, so it is neither
 * draggable nor a landing spot.
 *
 * Coexisting with bb's drag-to-split gesture: both start from the same
 * pointerdown on the row anchor. dnd-kit activates after
 * `DRAG_DISTANCE_PX`; the split engages only once the pointer leaves the
 * sidebar for the main area (its documented rule). So a drag that stays in
 * the sidebar nests and the split never engages, and a drag out to the main
 * area splits while this drag ends over nothing and does nothing. Neither
 * handler cancels the other; the destination decides.
 */
export function useSidebarDrag({
  onNestedUnder,
  onProjectDrop,
  onAnyDragEnd,
}: {
  /** A row nested under another: the parent, so a folded family can open. */
  onNestedUnder?: (parentThreadId: string) => void;
  /** A group landed on another group in its shelf. */
  onProjectDrop?: (drop: SidebarProjectDrop) => void;
  /** Any drag settled — dropped or not — so a trailing click can be held. */
  onAnyDragEnd?: () => void;
}): { drag: SidebarDragApi; contextProps: DndContextProps } {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [source, setSource] = useState<SidebarDragPayload | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }),
    // Space starts and drops; Enter stays the anchor's own open, and the
    // arrows move the pick between droppables only while a drag is live.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const onDragStart = useCommittedEvent((event: DragStartEvent) =>
    setSource(sidebarDragPayload(event.active)),
  );
  const onDragCancel = useCommittedEvent(() => {
    setSource(null);
    onAnyDragEnd?.();
  });
  const onDragEnd = useCommittedEvent((event: DragEndEvent) => {
    setSource(null);
    onAnyDragEnd?.();
    const payload = sidebarDragPayload(event.active);
    if (payload === null) return;
    if (payload.kind === "thread") {
      const parentThreadId =
        event.over === null ? undefined : parentFromDropId(String(event.over.id));
      if (parentThreadId === undefined) return;
      // The row moves when bb reports the change; a refused or failed write
      // leaves it where it was, which is what the screen already shows.
      void rpc.call("nestThread", { threadId: payload.threadId, parentThreadId }).catch(() => {});
      if (parentThreadId !== null) onNestedUnder?.(parentThreadId);
      return;
    }
    // A group drop resolves against its own shelf's sortable list: `over` is
    // the sortable item it landed on — the collision rule already ruled out
    // anything else — and the landing edge comes from which side of it the
    // dragged group was travelling.
    if (event.over === null || !hasSortableData(event.over) || !hasSortableData(event.active)) {
      return;
    }
    const over = sidebarDragPayload(event.over);
    if (over?.kind !== "project") return;
    const dragged = event.active.data.current.sortable;
    const target = event.over.data.current.sortable;
    if (dragged.containerId !== target.containerId) return;
    const edge = projectDropEdge(dragged.index, target.index);
    if (edge === null) return;
    onProjectDrop?.({ projectId: payload.projectId, overProjectId: over.projectId, edge });
  });
  const drag = useMemo<SidebarDragApi>(() => ({ source }), [source]);
  const contextProps = useMemo<DndContextProps>(
    () => ({
      sensors,
      collisionDetection: sidebarCollision,
      modifiers: sidebarModifiers,
      onDragStart,
      onDragEnd,
      onDragCancel,
    }),
    [sensors, onDragStart, onDragEnd, onDragCancel],
  );
  return { drag, contextProps };
}

/**
 * One thread row as both a drag source and a drop target. `disabled` turns
 * both off (compact viewport); `dropAllowed` is the tree's verdict for the
 * row being dragged.
 */
export function useNestRow(threadId: string, dropAllowed: boolean, disabled: boolean) {
  const draggable = useDraggable({ id: threadId, data: { kind: DRAG_KIND.thread }, disabled });
  const droppable = useDroppable({
    id: threadDropId(threadId),
    disabled: disabled || !dropAllowed,
  });
  return {
    setDragRef: draggable.setNodeRef,
    setDropRef: droppable.setNodeRef,
    listeners: disabled ? undefined : draggable.listeners,
    isDragging: draggable.isDragging,
    isOver: droppable.isOver,
  };
}

/** A project header as the drop target that lifts a row to the top level. */
export function useNestProjectHeader(shelf: InboxShelf, projectId: string, dropAllowed: boolean) {
  const droppable = useDroppable({ id: projectDropId(shelf, projectId), disabled: !dropAllowed });
  return { setDropRef: droppable.setNodeRef, isOver: droppable.isOver };
}
