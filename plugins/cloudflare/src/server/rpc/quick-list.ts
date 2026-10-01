import { defineQuery } from "@bb-kit/core/rpc";
import { quickListSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const quickList = defineQuery({
  output: quickListSchema,
  execute: (ctx: CloudflareContext) => ctx.quickShares.list(),
});
