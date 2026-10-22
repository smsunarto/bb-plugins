import type { CanvasNode } from "./schema.ts";

/** Remove every generation input to a deleted node, including a linked prompt source. */
export function filterNodeReferences(data: CanvasNode["data"], keep: (nodeId: string) => boolean) {
  const next = { ...data };
  const dropped = (ref: CanvasNode["data"][string]) =>
    typeof ref === "object" &&
    ref !== null &&
    !Array.isArray(ref) &&
    ref.type === "node" &&
    (typeof ref.nodeId !== "string" || !keep(ref.nodeId));
  for (const key of ["images", "references"])
    if (Array.isArray(next[key])) next[key] = next[key].filter((ref) => !dropped(ref));
  if (next.promptSource !== undefined && dropped(next.promptSource)) delete next.promptSource;
  return next;
}
