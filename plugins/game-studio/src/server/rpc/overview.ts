import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { overviewSchema } from "../../shared/schema.ts";
import { overview as runOverview } from "../lib/studio.ts";

export const overview = defineQuery({
  input: z.object({}).strict(),
  output: overviewSchema,
  execute(ctx) {
    return runOverview(ctx.bb);
  },
});
