import { defineMutation } from "@bb-kit/core/rpc";
import { quickIdSchema, quickResultSchema } from "../../shared/schema.ts";
import { getQuickShares } from "../lib/quick-shares.ts";
export const quickStart = defineMutation({
  input: quickIdSchema,
  output: quickResultSchema,
  execute: (ctx, input) => getQuickShares(ctx.bb).start(input.id),
});
