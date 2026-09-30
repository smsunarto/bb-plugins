import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { getTargetStore } from "../lib/targets.ts";

export const cloudIntent = defineQuery({
  output: z.object({ armed: z.boolean() }).strict(),
  async execute(ctx) {
    return { armed: getTargetStore(ctx.bb).cloudArmed() };
  },
});
