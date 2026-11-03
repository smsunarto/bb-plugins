import { arrayMove } from "@dnd-kit/sortable";

export type ProjectMoveDirection = "up" | "down";

/**
 * `bb.sdk.projects.reorder` arguments for moving a project past the group
 * next to it in one shelf.
 *
 * The neighbour is the adjacent group in the shelf, so one click is one
 * visible move; the anchors come from bb's full project order, so the write
 * lands the same no matter which shelf it was made from. Null when the move
 * cannot run: no group on that side, or either project is missing from bb's
 * order — the personal project is never in it, which is what keeps it pinned
 * to the bottom and immovable.
 */
export function projectReorderArgs(
  projectId: string,
  direction: ProjectMoveDirection,
  shelfOrder: readonly string[],
  projectOrder: readonly string[],
): { previousProjectId: string | null; nextProjectId: string | null } | null {
  if (!projectOrder.includes(projectId)) return null;
  const at = shelfOrder.indexOf(projectId);
  const neighbourId =
    at < 0 ? undefined : direction === "up" ? shelfOrder[at - 1] : shelfOrder[at + 1];
  if (neighbourId === undefined) return null;
  const to = projectOrder.indexOf(neighbourId);
  if (to < 0) return null;
  // `at` and `to` order the same way — shelf order is project order filtered
  // to the groups it shows — so the moved id can never sit on the picked side
  // of the neighbour.
  return direction === "up"
    ? { previousProjectId: projectOrder[to - 1] ?? null, nextProjectId: neighbourId }
    : { previousProjectId: neighbourId, nextProjectId: projectOrder[to + 1] ?? null };
}

/** Which side of the drop target a dragged group header lands on. */
export type ProjectDropEdge = "before" | "after";

/**
 * `bb.sdk.projects.reorder` arguments for a group header dropped onto another
 * group in a shelf — the drag counterpart of `projectReorderArgs`.
 *
 * `edge` is the side of `overProjectId` the header lands on, and the anchors
 * come from bb's full project order, so a project the shelf does not show is
 * jumped identically from every shelf. Null when the drop cannot run: either
 * project missing from bb's order (the personal project is never in it), the
 * header dropped on itself, or the spot it would land is the one it already
 * holds.
 */
export function projectDropReorderArgs(
  projectId: string,
  overProjectId: string,
  edge: ProjectDropEdge,
  projectOrder: readonly string[],
): { previousProjectId: string | null; nextProjectId: string | null } | null {
  const from = projectOrder.indexOf(projectId);
  const to = projectOrder.indexOf(overProjectId);
  if (from < 0 || to < 0 || from === to) return null;
  const without = projectOrder.filter((id) => id !== projectId);
  const at = to > from ? to - 1 : to;
  const insertAt = edge === "before" ? at : at + 1;
  // insertAt in the shortened order is also the dragged project's own slot,
  // so equality means the drop asks for the place it already has.
  if (insertAt === from) return null;
  return {
    previousProjectId: without[insertAt - 1] ?? null,
    nextProjectId: without[insertAt] ?? null,
  };
}

/**
 * The reorder a group-header drag asks for, from the shelf's group order
 * before and after the drop. A drag moves one group, so the moved project is
 * the one whose removal leaves both orders equal; it lands before the group
 * that now follows it, or after the one before it at the end. Null when the
 * orders differ by more than one move or the drop changes nothing in bb.
 */
export function groupDropReorderArgs(
  shelfOrder: readonly string[],
  nextShelfOrder: readonly string[],
  projectOrder: readonly string[],
): {
  projectId: string;
  args: { previousProjectId: string | null; nextProjectId: string | null };
} | null {
  const sameWithout = (id: string) => {
    const left = shelfOrder.filter((entry) => entry !== id);
    const right = nextShelfOrder.filter((entry) => entry !== id);
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  };
  const projectId = nextShelfOrder.find((id, index) => shelfOrder[index] !== id && sameWithout(id));
  if (projectId === undefined) return null;
  const at = nextShelfOrder.indexOf(projectId);
  const following = nextShelfOrder[at + 1];
  const preceding = nextShelfOrder[at - 1];
  const args =
    following !== undefined
      ? projectDropReorderArgs(projectId, following, "before", projectOrder)
      : preceding !== undefined
        ? projectDropReorderArgs(projectId, preceding, "after", projectOrder)
        : null;
  return args === null ? null : { projectId, args };
}

/**
 * The order a resolved drop predicts: the dragged project moved to the slot
 * the anchors describe. Drawn in place of bb's order until the host's
 * project-order-changed publish lands — the prediction every shelf mirrors —
 * and dropped the moment the real order arrives.
 */
export function applyProjectMove(
  projectOrder: readonly string[],
  projectId: string,
  args: { previousProjectId: string | null; nextProjectId: string | null },
): string[] {
  const without = projectOrder.filter((id) => id !== projectId);
  const insertAt =
    args.nextProjectId === null ? without.length : without.indexOf(args.nextProjectId);
  return arrayMove([...projectOrder], projectOrder.indexOf(projectId), insertAt);
}
