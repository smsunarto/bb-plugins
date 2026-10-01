import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import { gitbutlerHostContract } from "../../shared/host-contract.ts";
import {
  branchActionResultSchema,
  branchActionSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { resolveTarget } from "../lib/target.ts";

/** Pushes and review creation talk to a remote, so they get longer than a read. */
const ACTION_TIMEOUT_MS = 5 * 60_000;

export const branchAction = defineMutation({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      action: branchActionSchema,
    })
    .strict(),
  output: branchActionResultSchema,
  async execute(ctx, { threadId, repositoryKey, action }) {
    const { target, reason } = await resolveTarget(ctx.bb, threadId);
    if (!target) throw new Error(reason);
    return ctx.bb.hosts.experimental_client({ contract: gitbutlerHostContract }).call(
      "branchAction",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        action,
      },
      { hostId: target.hostId, timeoutMs: ACTION_TIMEOUT_MS },
    );
  },
});
