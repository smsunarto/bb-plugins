import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { getTargetStore } from "../lib/targets.ts";

const armedSchema = z.object({ armed: z.boolean() }).strict();

export const setCloudIntent = defineMutation({
  input: armedSchema,
  output: armedSchema,
  async execute(ctx, { armed }) {
    getTargetStore(ctx.bb).setCloudArmed(armed);
    return { armed };
  },
});
