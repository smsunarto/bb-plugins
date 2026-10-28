import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  patchesSchema,
  patchSourceSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const patchesContract = {
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
      source: patchSourceSchema,
    })
    .strict(),
  output: patchesSchema,
};

export async function patches(
  ctx: GitButlerContext,
  { threadId, checkout, repositoryKey, source }: z.output<typeof patchesContract.input>,
): Promise<z.input<typeof patchesContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, repositoryKey);
  if (!target) throw new Error(reason);
  return hostClient(ctx.bb).call(
    "patches",
    {
      ...repositoryTarget(target, repositoryKey),
      source,
    },
    { hostId: target.hostId },
  );
}
