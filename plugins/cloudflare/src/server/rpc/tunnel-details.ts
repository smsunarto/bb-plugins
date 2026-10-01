import { defineQuery } from "@bb-kit/core/rpc";
import { tunnelTargetSchema, tunnelDetailsSchema } from "../../shared/schema.ts";
import type { CloudflareContext } from "../lib/context.ts";
export const tunnelDetails = defineQuery({
  input: tunnelTargetSchema,
  output: tunnelDetailsSchema,
  execute: (ctx: CloudflareContext, input) => ctx.cloudflare.tunnelDetails(input),
});
