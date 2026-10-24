import { nodeRecipe, recipes } from "../shared/recipes.ts";
import type { CanvasNode, GenerationRecipe, NodeKind } from "../shared/schema.ts";
import {
  agentSelection,
  modelEditDefaults,
  rigTypes,
  type AgentSelection,
} from "../shared/generation.ts";

export type NodePatch = Record<string, CanvasNode["data"][string]>;

const settings: Partial<Record<NodeKind, Field[]>> = {
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

type Field = { key: string; label: string; options: (string | number)[] };
/** Settings a model adds to its kind's own, such as Tripo's rig type. */
const recipeSettings: Partial<Record<GenerationRecipe, Field[]>> = {
  "tripo-texture": [
    { key: "textureQuality", label: "Quality", options: ["detailed", "standard", "extreme"] },
  ],
  "tripo-rig": [{ key: "rigType", label: "Rig", options: [...rigTypes] }],
  "tripo-animate": [
    {
      key: "animation",
      label: "Animation",
      // Tripo qualifies short biped names with the rig's type; creatures have their own.
      options: [
        "preset:idle",
        "preset:walk",
        "preset:run",
        "preset:jump",
        "preset:quadruped:walk",
        "preset:hexapod:walk",
        "preset:octopod:walk",
        "preset:serpentine:march",
        "preset:aquatic:march",
      ],
    },
  ],
};
const optionLabels: Record<string, (option: string | number) => string> = {
  duration: (option) => `${option}s`,
  batch: (option) => `×${option}`,
  animation: (option) => String(option).replace(/^preset:/, ""),
};
const numeric = new Set(["duration", "batch"]);
/** Images per Nano Banana run; each image is its own request. */
export const nodeBatch = (node: CanvasNode) =>
  nodeRecipe(node)?.id === "nano-banana" && [2, 4].includes(Number(node.data.batch))
    ? Number(node.data.batch)
    : 1;
/** The model a node's output comes from. Text is the user's own, so it names none. */
export const nodeModelLabel = (node: CanvasNode) =>
  node.type === "text" || node.type === "agent" ? undefined : nodeRecipe(node)?.label;
/** A BB agent as the picker summarizes it. */
export const agentLabel = (agent: AgentSelection) =>
  [agent.model, agent.reasoningLevel, agent.serviceTier !== "default" && agent.serviceTier]
    .filter(Boolean)
    .join(" · ");
/** The BB agent saved on a text node, when one was chosen. */
export const nodeAgent = (node: CanvasNode): AgentSelection | undefined => {
  const parsed = agentSelection.safeParse(node.data.agent);
  return parsed.success ? parsed.data : undefined;
};
/** The field holding a node's brief, when it can generate. */
export const promptField = (kind: NodeKind) =>
  kind === "text" || kind === "agent"
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
    ...[...(settings[node.type] ?? []), ...((current && recipeSettings[current.id]) ?? [])]
      // Midjourney always returns four images per run.
      .filter((field) => field.key !== "batch" || current?.id === "nano-banana")
      .map((field) => ({
        key: field.key,
        label: field.label,
        value: String(
          node.data[field.key] ??
            modelEditDefaults[field.key as keyof typeof modelEditDefaults] ??
            field.options[0],
        ),
        options: field.options.map((option) => ({
          value: String(option),
          label: optionLabels[field.key]?.(option) ?? String(option),
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
  node.type === "text" || node.type === "agent" || !!nodeRecipe(node)?.direct;
