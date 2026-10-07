import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { TargetsContext } from "../lib/targets.ts";

export const cloudIntent = defineQuery({
  output: z.object({ armed: z.boolean() }).strict(),
  async execute(ctx: TargetsContext) {
    return { armed: ctx.targets.cloudArmed() };
  },
});
