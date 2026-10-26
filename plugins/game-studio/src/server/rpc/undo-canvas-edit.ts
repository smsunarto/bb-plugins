import { defineMutation } from "@bb-kit/core/rpc";
import { revisionSchema, undoCanvasEditInput } from "../../shared/schema.ts";
import type { GenerationContext } from "../lib/generations.ts";
export const undoCanvasEdit = defineMutation({
  input: undoCanvasEditInput,
  output: revisionSchema,
  execute: (ctx: GenerationContext, input) => ctx.generations.undoEdit(input),
});
