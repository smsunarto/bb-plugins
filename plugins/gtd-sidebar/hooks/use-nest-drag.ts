import { useMemo, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DndContextProps,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { gtdSidebarRpcContract } from "@/server";
import { useCommittedEvent } from "@/hooks/use-committed-event";
import type { InboxShelf } from "@/lib/inbox-tree";

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

export interface NestDragApi {
  /** The row being dragged, null between drags. */
  sourceId: string | null;
  /** Its title, for the drag ghost. */
  sourceTitle: string | null;
}

/**
 * Nesting by drag, on dnd-kit: a row dragged onto another row becomes its
 * child; dropped on a project header it goes back to the top level. The drop
 * is bb's `threads.update({ parentThreadId })` through the backend, and the
 * sidebar redraws off bb's own thread feed, so no local reorder happens here.
 *
 * Which targets may take the drop is decided by the tree (`nestDropAllowed`,
 * `unnestDropAllowed`); a refused target is a disabled droppable, so dnd-kit
 * never reports it as `over` and it never lights up.
 *
 * Coexisting with bb's drag-to-split gesture: both start from the same
 * pointerdown on the row anchor. dnd-kit activates after
 * `DRAG_DISTANCE_PX`; the split engages only once the pointer leaves the
 * sidebar for the main area (its documented rule). So a drag that stays in
 * the sidebar nests and the split never engages, and a drag out to the main
 * area splits while this drag ends over nothing and does nothing. Neither
 * handler cancels the other; the destination decides.
 */
export function useNestDrag(
  titleFor: (threadId: string) => string | null,
  onNestedUnder: (parentThreadId: string) => void,
): { nest: NestDragApi; contextProps: DndContextProps } {
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const [sourceId, setSourceId] = useState<string | null>(null);
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
    setSourceId(String(event.active.id)),
  );
  const onDragCancel = useCommittedEvent(() => setSourceId(null));
  const onDragEnd = useCommittedEvent((event: DragEndEvent) => {
    setSourceId(null);
    const threadId = String(event.active.id);
    const parentThreadId =
      event.over === null ? undefined : parentFromDropId(String(event.over.id));
    if (parentThreadId === undefined) return;
    // The row moves when bb reports the change; a refused or failed write
    // leaves it where it was, which is what the screen already shows.
    void rpc.call("nestThread", { threadId, parentThreadId }).catch(() => {});
    if (parentThreadId !== null) onNestedUnder(parentThreadId);
  });
  const nest = useMemo(
    () => ({ sourceId, sourceTitle: sourceId === null ? null : titleFor(sourceId) }),
    [sourceId, titleFor],
  );
  const contextProps = useMemo<DndContextProps>(
    () => ({
      sensors,
      collisionDetection: pointerWithin,
      onDragStart,
      onDragEnd,
      onDragCancel,
    }),
    [sensors, onDragStart, onDragEnd, onDragCancel],
  );
  return { nest, contextProps };
}

/**
 * One thread row as both a drag source and a drop target. `disabled` turns
 * both off (compact viewport); `dropAllowed` is the tree's verdict for the
 * row being dragged.
 */
export function useNestRow(threadId: string, dropAllowed: boolean, disabled: boolean) {
  const draggable = useDraggable({ id: threadId, disabled });
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
