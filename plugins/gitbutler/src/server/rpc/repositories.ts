import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import { repositoriesSchema } from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const repositories = defineQuery({
  input: z.object({ threadId: z.string().min(1) }).strict(),
  output: repositoriesSchema,
  async execute(ctx, { threadId }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) return { repositories: [], reason };
    return ctx.bb.hosts
      .experimental_client({ contract: gitbutlerHostContract })
      .call("repositories", { environmentPath: target.environmentPath }, { hostId: target.hostId });
  },
});
