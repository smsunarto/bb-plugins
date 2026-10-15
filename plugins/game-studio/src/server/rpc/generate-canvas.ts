import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { canvasDirectInput, generationJob } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generateCanvas = defineMutation({
  input: canvasDirectInput,
  output: z.strictObject({ created: z.boolean(), job: generationJob }),
  execute: (ctx: GenerationContext, input) => ctx.generations.direct(input),
});
