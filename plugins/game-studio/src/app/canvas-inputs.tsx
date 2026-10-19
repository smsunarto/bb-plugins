import { outputType } from "../shared/inputs.ts";
import { nodeInputs } from "../shared/recipes.ts";
import type { Asset, CanvasNode } from "../shared/schema.ts";
export function inputNodeIds(node: CanvasNode): string[] {
  return [
    ...new Set(
      [
        node.data.images,
        node.data.references,
        node.data.promptSource ? [node.data.promptSource] : [],
      ]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .flatMap((ref) =>
          typeof ref === "object" &&
          ref !== null &&
          !Array.isArray(ref) &&
          ref.type === "node" &&
          typeof ref.nodeId === "string"
            ? [ref.nodeId]
            : [],
        ),
    ),
  ];
}
export function CanvasInputs({
  node,
  nodes,
  assets,
  onToggle,
}: {
  node: CanvasNode;
  nodes: CanvasNode[];
  assets: Asset[];
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const selected = inputNodeIds(node);
  const ports = nodeInputs(node, (id) => nodes.find((other) => other.id === id)?.type);
  const typed = (other: CanvasNode) =>
    ports.filter(({ port }) => port.type === outputType(other.type));
  const candidates = nodes.filter((other) => other.id !== node.id && typed(other).length);
  const full = (other: CanvasNode) =>
    typed(other).every(({ port, refs }) => refs.length >= port.max);
  return (
    <fieldset className="gs-inspector-section gs-canvas-inputs">
      <legend>Inputs</legend>
      <small className="gs-muted">
        {node.type === "review"
          ? "Text sets the criteria; images and 3D models are reviewed."
          : "Text adds context; images add visual references."}
      </small>
      {candidates.length ? (
        candidates.map((other) => {
          const output = { image: "image", "model-3d": "model" }[other.type as string];
          const missing =
            !!output &&
            !assets.some((asset) => asset.id === other.data.assetId && asset.type === output);
          const label =
            { image: "Image", "model-3d": "3D model", document: "Document", review: "Review" }[
              other.type as string
            ] ?? "Text";
          const checked = selected.includes(other.id);
          return (
            <label key={other.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && (missing || full(other))}
                onChange={(event) => onToggle(other.id, event.target.checked)}
              />
              <span>
                {other.title || other.type}
                <small>{missing ? `${label} · no output yet` : label}</small>
              </span>
            </label>
          );
        })
      ) : (
        <p className="gs-muted">
          {node.type === "review"
            ? "Add a text, image or 3D node to review."
            : "Add a text, document or image node to use as input."}
        </p>
      )}
    </fieldset>
  );
}
