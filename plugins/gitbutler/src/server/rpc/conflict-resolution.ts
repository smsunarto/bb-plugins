import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import { conflictResolutionSchema, repositoryKeySchema } from "../../shared/schema.ts";
import { readConflictResolution } from "../lib/conflict-resolution.ts";
import { locateRepository } from "../lib/subthreads.ts";

/** The Resolve conflicts subthread of the repository on screen, whichever thread started it. */
export const conflictResolution = defineQuery({
  input: z
    .object({ threadId: z.string().min(1), repositoryKey: repositoryKeySchema.optional() })
    .strict(),
  output: conflictResolutionSchema,
  async execute(ctx, { threadId, repositoryKey }) {
    const repository = await locateRepository(ctx.bb, threadId, repositoryKey);
    return { subthread: await readConflictResolution(ctx.bb, repository) };
  },
});
