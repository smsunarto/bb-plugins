import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { checkoutSelectionSchema, repositoriesSchema } from "../../shared/schema.ts";
import { hostClient, repositoryTarget, resolveTarget } from "../lib/target.ts";

export const repositories = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), checkout: checkoutSelectionSchema.optional() })
    .strict(),
  output: repositoriesSchema,
  async execute(ctx, { threadId, checkout }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId, checkout, undefined);
    if (!target) return { repositories: [], reason };
    return hostClient(ctx.bb).call("repositories", repositoryTarget(target), {
      hostId: target.hostId,
    });
  },
});
