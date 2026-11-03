/**
 * What the pointer picked up in the sidebar — the discriminant every drag
 * handler branches on. A thread row marks itself `"thread"` and a project
 * group header `"project"`; the one drag context carries both and the drop
 * resolver for each kind reads only its own payload.
 */
export type SidebarDragPayload =
  | { kind: "thread"; threadId: string }
  | { kind: "project"; projectId: string };

/** The `data.kind` each sidebar draggable marks itself with. */
export const DRAG_KIND = { thread: "thread", project: "project" } as const;

/**
 * The payload a dnd-kit entry carries, or null for anything that is not one
 * of ours. `active` and `over` both pass through here: the `thread:` and
 * `project:` droppables a row nests under carry no `data.kind`, so a drop
 * target can never be mistaken for a dragged project group, nor a dragged
 * group for a thread.
 */
export function sidebarDragPayload(
  entry: { id: unknown; data?: { current?: unknown } } | null | undefined,
): SidebarDragPayload | null {
  const data = entry?.data?.current;
  if (data === null || typeof data !== "object") return null;
  const kind = (data as { kind?: unknown }).kind;
  if (kind === DRAG_KIND.thread && typeof entry?.id === "string") {
    return { kind: "thread", threadId: entry.id };
  }
  if (kind === DRAG_KIND.project && typeof entry?.id === "string") {
    return { kind: "project", projectId: entry.id };
  }
  return null;
}
