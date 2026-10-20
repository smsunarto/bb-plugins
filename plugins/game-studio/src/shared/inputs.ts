import type { CanvasNode, NodeKind } from "./schema.ts";

/** What an output carries into another node's generation. */
export type InputType = "text" | "image";
/** A typed input on a canvas node, holding at most `max` connections. */
export type InputPort = {
  id: string;
  type: InputType;
  label: string;
  max: number;
  required?: boolean;
};
export const textPort: InputPort = {
  id: "text",
  type: "text",
  label: "Text",
  max: Number.POSITIVE_INFINITY,
};
export const imagesPort = (max: number): InputPort => ({
  id: "image",
  type: "image",
  label: "Image",
  max,
});
/** One image with a fixed role, such as a video's start frame or a 3D model's front view. */
export const imageSlot = (id: string, label: string, required?: true): InputPort => ({
  id,
  type: "image",
  label,
  max: 1,
  ...(required ? { required } : {}),
});

/** The input type a node's output feeds, when generation can consume it. */
export function outputType(kind: NodeKind | undefined): InputType | undefined {
  if (kind === "text" || kind === "document") return "text";
  if (kind === "image") return "image";
  return undefined;
}

type Json = CanvasNode["data"][string];
export type InputRef = { [key: string]: Json };
/** A node's saved inputs in connection order: its prompt source, then images and references. */
export function nodeRefs(node: Pick<CanvasNode, "data">): InputRef[] {
  return [[node.data.promptSource], node.data.images, node.data.references]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter(
      (ref): ref is InputRef => typeof ref === "object" && ref !== null && !Array.isArray(ref),
    );
}
export function refType(
  ref: InputRef,
  kindOf: (nodeId: string) => NodeKind | undefined,
): InputType | undefined {
  if (ref.type === "library") return "image";
  return ref.type === "node" && typeof ref.nodeId === "string"
    ? outputType(kindOf(ref.nodeId))
    : undefined;
}

export type PortInputs<T> = { port: InputPort; refs: T[] };
/**
 * Place each input on a port: its saved `port` while the model has it with room, otherwise
 * the first open port of its type in connection order. Inputs without room overfill the last
 * port of their type, or a port the model lacks, so the canvas still shows them for removal.
 */
export function assignInputs<T extends { port?: unknown }>(
  ports: InputPort[],
  inputs: { ref: T; type: InputType }[],
): PortInputs<T>[] {
  const assigned = ports.map((port) => ({ port, refs: [] as T[] }));
  const open = (item: PortInputs<T>) => item.refs.length < item.port.max;
  const unplaced = inputs.filter(({ ref, type }) => {
    const item = assigned.find(
      (candidate) =>
        candidate.port.id === ref.port && candidate.port.type === type && open(candidate),
    );
    item?.refs.push(ref);
    return !item;
  });
  for (const { ref, type } of unplaced) {
    const typed = assigned.filter((item) => item.port.type === type);
    let item = typed.find(open) ?? typed.at(-1);
    if (!item) {
      item = { port: { ...(type === "text" ? textPort : imagesPort(0)), max: 0 }, refs: [] };
      assigned.push(item);
    }
    item.refs.push(ref);
  }
  return assigned;
}
