import { defineMutation } from "@bb-kit/core/rpc";
import { shareInputSchema, resultSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const start = defineMutation({
  input: shareInputSchema,
  output: resultSchema,
  execute: (ctx, input) => getService(ctx.bb).start(input.id, input.expectedRevision),
});
