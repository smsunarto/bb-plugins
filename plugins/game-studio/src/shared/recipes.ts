import { generationRecipeSchema } from "./schema.ts";
import type { CanvasNode, GenerationRecipe, NodeKind } from "./schema.ts";
import { briefRecipe } from "./generation.ts";

/** A typed input on a canvas node. Edges join an output to the port of the same type. */
export type InputPort = "text" | "image";
/** The ports a model accepts, each with the most connections it uses. */
export type InputPorts = Partial<Record<InputPort, number>>;
const anyText = Number.POSITIVE_INFINITY;

/** Canvas models per node kind; the first entry of a kind is its default. */
export const recipes: {
  id: GenerationRecipe;
  kind: NodeKind;
  label: string;
  inputs: InputPorts;
  /** Generated on the canvas; otherwise prepared as a native composer request. */
  direct?: boolean;
}[] = [
  {
    id: "nano-banana",
    kind: "image",
    label: "Nano Banana 2.1",
    inputs: { text: anyText, image: 14 },
    direct: true,
  },
  {
    id: "concept-art",
    kind: "image",
    label: "Midjourney",
    inputs: { text: anyText, image: 14 },
    direct: true,
  },
  // Video models take a start frame and an optional end frame.
  { id: "omni-video", kind: "video", label: "Gemini Omni", inputs: { text: anyText, image: 2 } },
  { id: "fal-video", kind: "video", label: "Fal H3 Max", inputs: { text: anyText, image: 2 } },
  // Tripo builds geometry from one approved image chosen among the connected ones.
  { id: "model-3d", kind: "model-3d", label: "Tripo P2", inputs: { image: 14 } },
  { id: "voice-sfx", kind: "asset", label: "ElevenLabs", inputs: { text: anyText } },
  { id: "music", kind: "asset", label: "Suno", inputs: { text: anyText } },
];

/** The node's saved model choice, or the kind's default. */
export function nodeRecipe(node: Pick<CanvasNode, "type" | "data">) {
  const saved = generationRecipeSchema.safeParse(node.data.recipe);
  const options = recipes.filter((recipe) => recipe.kind === node.type);
  return options.find((recipe) => saved.success && recipe.id === saved.data) ?? options[0];
}

/** The node's model when a BB model can write its prompt from instructions/prompting/<id>.md. */
export function nodeBriefRecipe(node: Pick<CanvasNode, "type" | "data">) {
  const recipe = nodeRecipe(node);
  const id = briefRecipe.safeParse(recipe?.id);
  return recipe && id.success ? { ...recipe, id: id.data } : undefined;
}

/** The ports the node's model accepts. Text nodes run on the BB model, which reads both. */
export function nodeInputPorts(node: Pick<CanvasNode, "type" | "data">): InputPorts {
  if (node.type === "text") return { text: anyText, image: 14 };
  return nodeRecipe(node)?.inputs ?? {};
}

/** The port a node's output feeds, when generation can consume it. */
export function outputPort(kind: NodeKind | undefined): InputPort | undefined {
  if (kind === "text" || kind === "document") return "text";
  if (kind === "image") return "image";
  return undefined;
}
