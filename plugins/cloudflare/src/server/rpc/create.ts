import { defineMutation } from "@bb-kit/core/rpc";
import { createSchema, resultSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const create = defineMutation({
  input: createSchema,
  output: resultSchema,
  execute: (ctx, input) => getService(ctx.bb).create(input),
});
