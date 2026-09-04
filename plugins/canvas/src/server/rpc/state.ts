import { defineQuery } from "@bb-kit/core/rpc";
import { canvasStateSchema, stateInputSchema } from "../../shared/document.ts";
import { readState } from "../state-store.ts";

export const state = defineQuery({
  input: stateInputSchema,
  output: canvasStateSchema,
  execute(ctx, { source }) {
    return readState(ctx.bb, source);
  },
});
