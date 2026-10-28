import type { GitButlerContext } from "../lib/context.ts";
import { z } from "zod";
import { checkoutSelectionSchema, repositoriesSchema } from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const repositoriesContract = {
  input: z
    .object({ threadId: z.string().min(1), checkout: checkoutSelectionSchema.optional() })
    .strict(),
  output: repositoriesSchema,
};

export async function repositories(
  ctx: GitButlerContext,
  { threadId, checkout }: z.output<typeof repositoriesContract.input>,
): Promise<z.input<typeof repositoriesContract.output>> {
  const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, undefined);
  if (!target) return { repositories: [], reason };
  return hostClient(ctx.bb).call("repositories", repositoryTarget(target), {
    hostId: target.hostId,
  });
}
