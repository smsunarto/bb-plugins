import { defineQuery } from "@bb-kit/core/rpc";
import { z } from "zod";
import {
  checkoutSelectionSchema,
  conflictResolutionSchema,
  repositoryKeySchema,
} from "../../shared/schema.ts";
import { readConflictResolution } from "../lib/conflict-resolution.ts";
import { locateForRead } from "../lib/subthreads.ts";

/** The Resolve conflicts subthread of the repository on screen, whichever thread started it. */
export const conflictResolution = defineQuery({
  input: z
    .object({
      threadId: z.string().min(1),
      checkout: checkoutSelectionSchema.optional(),
      repositoryKey: repositoryKeySchema.optional(),
    })
    .strict(),
  output: conflictResolutionSchema,
  async execute(ctx, { threadId, checkout, repositoryKey }) {
    const repository = await locateForRead(ctx.bb, threadId, repositoryKey, checkout);
    return { subthread: await readConflictResolution(ctx.bb, repository) };
  },
});
