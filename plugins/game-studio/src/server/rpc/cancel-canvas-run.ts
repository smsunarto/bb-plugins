import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { cancelCanvasRunInput } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const cancelCanvasRun = defineMutation({
  input: cancelCanvasRunInput,
  output: z.strictObject({ cancelled: z.boolean() }),
  description: "Drop a canvas run held for a node until its inputs have outputs.",
  execute: (ctx: GenerationContext, input) => ctx.generations.cancel(input),
});
