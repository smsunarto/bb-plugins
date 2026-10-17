import { generationRecipeSchema } from "./schema.ts";
import type { CanvasNode, GenerationRecipe, NodeKind } from "./schema.ts";
import { briefRecipe } from "./generation.ts";
import {
  assignInputs,
  imageSlot,
  imagesPort,
  nodeRefs,
  refType,
  textPort,
  type InputPort,
} from "./inputs.ts";

const textAndImages = [textPort, imagesPort(14)];
// Video models animate from a start frame, optionally toward an end frame.
const frames = [textPort, imageSlot("start", "Start"), imageSlot("end", "End")];
// Tripo builds geometry from a front view, optionally with further views of the same subject.
const views = [
  imageSlot("front", "Front", true),
  imageSlot("left", "Left"),
  imageSlot("back", "Back"),
  imageSlot("right", "Right"),
];

/** Canvas models per node kind; the first entry of a kind is its default. */
export const recipes: {
  id: GenerationRecipe;
  kind: NodeKind;
  label: string;
  inputs: InputPort[];
  /** Generated on the canvas; otherwise prepared as a native composer request. */
  direct?: boolean;
}[] = [
  {
    id: "nano-banana",
    kind: "image",
    label: "Nano Banana 2.1",
    inputs: textAndImages,
    direct: true,
  },
  {
    id: "concept-art",
    kind: "image",
    label: "Midjourney",
    inputs: textAndImages,
    direct: true,
  },
  { id: "omni-video", kind: "video", label: "Gemini Omni", inputs: frames },
  { id: "fal-video", kind: "video", label: "Fal H3 Max", inputs: frames },
  { id: "model-3d", kind: "model-3d", label: "Tripo P2", inputs: views },
  { id: "voice-sfx", kind: "asset", label: "ElevenLabs", inputs: [textPort] },
  { id: "music", kind: "asset", label: "Suno", inputs: [textPort] },
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
export function nodeInputPorts(node: Pick<CanvasNode, "type" | "data">): InputPort[] {
  if (node.type === "text") return textAndImages;
  return nodeRecipe(node)?.inputs ?? [];
}

/** The node's saved inputs placed on its model's ports. */
export function nodeInputs(
  node: Pick<CanvasNode, "type" | "data">,
  kindOf: (nodeId: string) => NodeKind | undefined,
) {
  return assignInputs(
    nodeInputPorts(node),
    nodeRefs(node).flatMap((ref) => {
      const type = refType(ref, kindOf);
      return type ? [{ ref, type }] : [];
    }),
  );
}
