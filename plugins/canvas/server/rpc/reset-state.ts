import { defineMutation } from "@bb-kit/core/rpc";
import { canvasStateSchema, stateInputSchema } from "../../shared/document.ts";
import { clearState } from "../state-store.ts";

export const resetState = defineMutation({
  input: stateInputSchema,
  output: canvasStateSchema,
  execute(ctx, { source }) {
    return clearState(ctx.bb, source);
  },
});
