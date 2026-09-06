import { defineMutation } from "@bb-kit/core/rpc";
import { updateSchema, resultSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const update = defineMutation({
  input: updateSchema,
  output: resultSchema,
  execute: (ctx, input) => getService(ctx.bb).update(input.id, input.spec, input.expectedRevision),
});
