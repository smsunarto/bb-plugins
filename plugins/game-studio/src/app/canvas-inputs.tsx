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
  const candidates = nodes.filter(
    (other) => other.id !== node.id && ["text", "document", "image"].includes(other.type),
  );
  return (
    <fieldset className="gs-inspector-section gs-canvas-inputs">
      <legend>Inputs</legend>
      <small className="gs-muted">Text adds context; images add visual references.</small>
      {candidates.length ? (
        candidates.map((other) => {
          const missing =
            other.type === "image" &&
            !assets.some((asset) => asset.id === other.data.assetId && asset.type === "image");
          return (
            <label key={other.id}>
              <input
                type="checkbox"
                checked={selected.includes(other.id)}
                disabled={missing && !selected.includes(other.id)}
                onChange={(event) => onToggle(other.id, event.target.checked)}
              />
              <span>
                {other.title || other.type}
                <small>
                  {other.type === "image"
                    ? missing
                      ? "Image · no output yet"
                      : "Image"
                    : other.type === "document"
                      ? "Document"
                      : "Text"}
                </small>
              </span>
            </label>
          );
        })
      ) : (
        <p className="gs-muted">Add a text, document or image node to use as input.</p>
      )}
    </fieldset>
  );
}
