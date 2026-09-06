import { defineQuery } from "@bb-kit/core/rpc";
import { tunnelTargetSchema, tunnelDetailsSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const tunnelDetails = defineQuery({
  input: tunnelTargetSchema,
  output: tunnelDetailsSchema,
  execute: (ctx, input) => getService(ctx.bb).tunnelDetails(input),
});
