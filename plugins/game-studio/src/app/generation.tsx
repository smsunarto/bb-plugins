import { generationRecipeSchema } from "../shared/schema.ts";
import type { CanvasNode, GenerationRecipe, NodeKind } from "../shared/schema.ts";

export type NodePatch = Record<string, CanvasNode["data"][string]>;

const recipes: {
  id: GenerationRecipe;
  kind: NodeKind;
  label: string;
  /** Generated on the canvas; otherwise prepared as a native composer request. */
  direct?: boolean;
}[] = [
  { id: "nano-banana", kind: "image", label: "Nano Banana 2.1", direct: true },
  { id: "concept-art", kind: "image", label: "Midjourney", direct: true },
  { id: "omni-video", kind: "video", label: "Gemini Omni" },
  { id: "fal-video", kind: "video", label: "Fal H3 Max" },
  { id: "model-3d", kind: "model-3d", label: "Tripo P2" },
  { id: "voice-sfx", kind: "asset", label: "ElevenLabs" },
  { id: "music", kind: "asset", label: "Suno" },
];
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
  ],
  video: [
    { key: "aspectRatio", label: "Aspect ratio", options: ["16:9", "9:16"] },
    { key: "duration", label: "Duration", options: [5, 8, 10] },
  ],
};

/** The node's saved model choice, or the kind's default. */
export function nodeRecipe(node: CanvasNode) {
  const saved = generationRecipeSchema.safeParse(node.data.recipe);
  const options = recipes.filter((recipe) => recipe.kind === node.type);
  return options.find((recipe) => saved.success && recipe.id === saved.data) ?? options[0];
}
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
    ...(settings[node.type] ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      value: String(node.data[field.key] ?? field.options[0]),
      options: field.options.map((option) => ({
        value: String(option),
        label: field.key === "duration" ? `${option}s` : String(option),
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
                [field.key]:
                  field.key === "duration" ? Number(event.target.value) : event.target.value,
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
