import { defineMutation } from "@bb-kit/core/rpc";
import { canvasStateSchema, setStateInputSchema } from "../../shared/document.ts";
import { writeState } from "../state-store.ts";

export const setState = defineMutation({
  input: setStateInputSchema,
  output: canvasStateSchema,
  execute(ctx, { source, key, value }) {
    return writeState(ctx.bb, source, key, value);
  },
});
