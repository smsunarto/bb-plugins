import { generationRecipeSchema } from "./schema.ts";
import type { CanvasNode, GenerationRecipe, NodeKind } from "./schema.ts";
import { briefRecipe } from "./generation.ts";

/** Canvas models per node kind; the first entry of a kind is its default. */
export const recipes: {
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
