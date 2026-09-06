import { defineMutation } from "@bb-kit/core/rpc";
import { quickCreateSchema, quickResultSchema } from "../../shared/schema.ts";
import { getQuickShares } from "../lib/quick-shares.ts";
export const quickCreate = defineMutation({
  input: quickCreateSchema,
  output: quickResultSchema,
  execute: (ctx, input) => getQuickShares(ctx.bb).create(input),
});
