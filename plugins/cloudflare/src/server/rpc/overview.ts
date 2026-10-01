import { defineQuery } from "@bb-kit/core/rpc";
import { overviewSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const overview = defineQuery({
  output: overviewSchema,
  execute: (ctx: CloudflareContext) => ctx.cloudflare.overview(),
});
