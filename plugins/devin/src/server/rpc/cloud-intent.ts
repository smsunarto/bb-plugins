import { z } from "zod";
import type { TargetsContext } from "../lib/targets.ts";

export const cloudIntentContract = {
  input: z.null(),
  output: z.object({ armed: z.boolean() }).strict(),
};

export async function cloudIntent(
  ctx: TargetsContext,
): Promise<z.input<typeof cloudIntentContract.output>> {
  return { armed: ctx.targets.cloudArmed() };
}
