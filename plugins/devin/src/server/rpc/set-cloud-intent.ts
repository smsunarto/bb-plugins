import { z } from "zod";
import type { TargetsContext } from "../lib/targets.ts";

const armedSchema = z.object({ armed: z.boolean() }).strict();

export const setCloudIntentContract = {
  input: armedSchema,
  output: armedSchema,
};

export async function setCloudIntent(
  ctx: TargetsContext,
  { armed }: z.output<typeof setCloudIntentContract.input>,
): Promise<z.input<typeof setCloudIntentContract.output>> {
  ctx.targets.setCloudArmed(armed);
  return { armed };
}
