import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import type { TargetsContext } from "../lib/targets.ts";

const armedSchema = z.object({ armed: z.boolean() }).strict();

export const setCloudIntent = defineMutation({
  input: armedSchema,
  output: armedSchema,
  async execute(ctx: TargetsContext, { armed }) {
    ctx.targets.setCloudArmed(armed);
    return { armed };
  },
});
