import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import {
  filePathSchema,
  patchSchema,
  patchSourceSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

export const patch = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      source: patchSourceSchema,
      path: filePathSchema,
    })
    .strict(),
  output: patchSchema,
  async execute(ctx, { threadId, repositoryKey, source, path }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) throw new Error(reason);
    return ctx.bb.hosts.experimental_client({ contract: gitbutlerHostContract }).call(
      "patch",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        source,
        path,
      },
      { hostId: target.hostId },
    );
  },
});
