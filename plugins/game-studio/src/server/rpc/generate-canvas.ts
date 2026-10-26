import { defineMutation } from "@bb-kit/core/rpc";
import { canvasDirectInput, canvasRunResult } from "../../shared/generation.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const generateCanvas = defineMutation({
  input: canvasDirectInput,
  output: canvasRunResult,
  execute: (ctx: GenerationContext, input) => ctx.generations.direct(input),
});
