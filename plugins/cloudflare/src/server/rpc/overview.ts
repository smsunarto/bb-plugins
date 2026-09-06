import { defineQuery } from "@bb-kit/core/rpc";
import { overviewSchema } from "../../shared/schema.ts";
import { getService } from "../lib/service.ts";
export const overview = defineQuery({
  output: overviewSchema,
  execute: (ctx) => getService(ctx.bb).overview(),
});
