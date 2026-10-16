import { nodeRecipe, recipes } from "../shared/recipes.ts";
import type { CanvasNode, NodeKind } from "../shared/schema.ts";

export type NodePatch = Record<string, CanvasNode["data"][string]>;

const settings: Partial<
  Record<NodeKind, { key: string; label: string; options: (string | number)[] }[]>
> = {
  image: [
    {
      key: "aspectRatio",
      label: "Aspect ratio",
      options: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    { key: "resolution", label: "Resolution", options: ["1K", "2K", "4K"] },
    { key: "batch", label: "Images", options: [1, 2, 4] },
  ],
  video: [
    { key: "aspectRatio", label: "Aspect ratio", options: ["16:9", "9:16"] },
    { key: "duration", label: "Duration", options: [5, 8, 10] },
  ],
};

const numeric = new Set(["duration", "batch"]);
/** Images per Nano Banana run; each image is its own request. */
export const nodeBatch = (node: CanvasNode) =>
  nodeRecipe(node)?.id === "nano-banana" && [2, 4].includes(Number(node.data.batch))
    ? Number(node.data.batch)
    : 1;
export const nodeModelLabel = (node: CanvasNode) =>
  node.type === "text" ? "BB model" : nodeRecipe(node)?.label;
/** The field holding a node's brief, when it can generate. */
export const promptField = (kind: NodeKind) =>
  kind === "text"
    ? "instruction"
    : ["image", "video", "model-3d", "asset"].includes(kind)
      ? "prompt"
      : undefined;

/** Model and output settings, shared by the node toolbar and the inspector. */
export function GenerationSettings({
  node,
  compact = false,
  onChange,
}: {
  node: CanvasNode;
  compact?: boolean;
  onChange: (patch: NodePatch) => void;
}) {
  const options = recipes.filter((recipe) => recipe.kind === node.type);
  const current = nodeRecipe(node);
  const fields = [
    ...(options.length
      ? [
          {
            key: "recipe",
            label: "Model",
            value: current?.id ?? "",
            options: options.map((recipe) => ({ value: recipe.id, label: recipe.label })),
          },
        ]
      : []),
    ...(settings[node.type] ?? [])
      // Midjourney always returns four images per run.
      .filter((field) => field.key !== "batch" || current?.id === "nano-banana")
      .map((field) => ({
        key: field.key,
        label: field.label,
        value: String(node.data[field.key] ?? field.options[0]),
        options: field.options.map((option) => ({
          value: String(option),
          label:
            field.key === "duration"
              ? `${option}s`
              : field.key === "batch"
                ? `×${option}`
                : String(option),
        })),
      })),
  ];
  if (!fields.length) return null;
  return (
    <div className="gs-generation-settings" data-compact={compact || undefined}>
      {fields.map((field) => (
        <label key={field.key} title={field.label}>
          <span>{compact && field.key === "recipe" ? "Model:" : field.label}</span>
          <select
            value={field.value}
            onChange={(event) =>
              onChange({
                [field.key]: numeric.has(field.key)
                  ? Number(event.target.value)
                  : event.target.value,
              })
            }
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

/** Whether running the node generates on the canvas instead of preparing a request. */
export const runsDirectly = (node: CanvasNode) =>
  node.type === "text" || !!nodeRecipe(node)?.direct;
