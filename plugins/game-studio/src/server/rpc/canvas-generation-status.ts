import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { canvasDirectControl, generationJob } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const canvasGenerationStatus = defineMutation({
  input: canvasDirectControl,
  output: z.strictObject({ job: generationJob.nullable(), detail: z.string().optional() }),
  execute: (ctx: GenerationContext, input) => ctx.generations.directControl(input),
});
