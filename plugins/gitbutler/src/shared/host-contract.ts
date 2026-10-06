import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseHistorySchema,
  branchNameSchema,
  butActionResultSchema,
  butActionSchema,
  commitIdSchema,
  environmentPathSchema,
  patchesSchema,
  patchSourceSchema,
  repositoriesSchema,
  repositoryKeySchema,
  resolvedRepositorySchema,
  reviewUrlSchema,
  workspaceSchema,
} from "./schema.ts";

const target = z.object({
  environmentPath: environmentPathSchema,
  repositoryKey: repositoryKeySchema.optional(),
});

export const gitbutlerHostContract = defineRpcContract({
  repositories: {
    input: z.object({ environmentPath: environmentPathSchema }).strict(),
    output: repositoriesSchema,
  },
  repository: { input: target.strict(), output: resolvedRepositorySchema },
  workspace: { input: target.strict(), output: workspaceSchema },
  baseHistory: {
    input: target
      .extend({
        from: commitIdSchema,
        offset: z.number().int().nonnegative().max(100_000),
        limit: z.number().int().min(1).max(500),
      })
      .strict(),
    output: baseHistorySchema,
  },
  patches: {
    input: target.extend({ source: patchSourceSchema }).strict(),
    output: patchesSchema,
  },
  butAction: {
    input: target.extend({ action: butActionSchema }).strict(),
    output: butActionResultSchema,
  },
  reviewUrl: {
    input: target.extend({ branch: branchNameSchema }).strict(),
    output: reviewUrlSchema,
  },
});
