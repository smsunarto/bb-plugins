import { defineMutation } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  butActionResultSchema,
  butActionSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { hostClient, writeTarget } from "../lib/target.ts";

/** Pushes, pulls, and review creation talk to a remote, so they get longer than a read. */
const ACTION_TIMEOUT_MS = 5 * 60_000;

export const butAction = defineMutation({
  input: z
    .object({
      threadId: z.string().min(1),
      repositoryKey: repositoryKeySchema.optional(),
      /** The environment of the board the reader acted on. */
      environmentId: z.string().min(1).optional(),
      action: butActionSchema,
    })
    .strict(),
  output: butActionResultSchema,
  async execute(ctx, { threadId, repositoryKey, environmentId, action }) {
    const target = await writeTarget(ctx.bb, threadId, environmentId);
    return hostClient(ctx.bb).call(
      "butAction",
      {
        environmentPath: target.environmentPath,
        ...(repositoryKey ? { repositoryKey } : {}),
        action,
      },
      { hostId: target.hostId, timeoutMs: ACTION_TIMEOUT_MS },
    );
  },
});
