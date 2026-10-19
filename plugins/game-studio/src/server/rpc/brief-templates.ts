import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import { nodeKindSchema } from "../../shared/schema.ts";
import { files } from "../lib/instructions.ts";

const templates = [
  { id: "concept", label: "Concept exploration", kinds: ["image"] },
  { id: "production-reference", label: "Isolated 3D reference", kinds: ["image"] },
  { id: "image-edit", label: "Preserve and edit", kinds: ["image"] },
  { id: "motion", label: "Motion study", kinds: ["video"] },
  { id: "model", label: "3D asset contract", kinds: ["model-3d"] },
  { id: "design-critique", label: "Design experiment", kinds: ["text"] },
  { id: "asset-review", label: "Game-ready 3D asset", kinds: ["review"] },
] as const;

export const briefTemplates = defineQuery({
  input: z.strictObject({ kind: nodeKindSchema }),
  output: z.object({
    templates: z.array(z.object({ id: z.string(), label: z.string(), text: z.string() })),
  }),
  execute(_ctx, { kind }) {
    return {
      templates: templates
        .filter((template) => template.kinds.some((candidate) => candidate === kind))
        .map(({ id, label }) => ({ id, label, text: files.read(`templates/briefs/${id}`).trim() })),
    };
  },
});
