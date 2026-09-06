import { defineQuery } from "@bb-kit/core/rpc";
import { quickListSchema } from "../../shared/schema.ts";
import { getQuickShares } from "../lib/quick-shares.ts";
export const quickList = defineQuery({
  output: quickListSchema,
  execute: (ctx) => getQuickShares(ctx.bb).list(),
});
