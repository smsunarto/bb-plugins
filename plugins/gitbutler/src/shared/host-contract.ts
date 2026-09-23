import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseHistorySchema,
  commitDetailsSchema,
  commitIdSchema,
  environmentPathSchema,
  patchesSchema,
  patchSourceSchema,
  repositoriesSchema,
  repositoryKeySchema,
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
  commit: {
    input: target.extend({ commitId: commitIdSchema }).strict(),
    output: commitDetailsSchema,
  },
  patches: {
    input: target.extend({ source: patchSourceSchema }).strict(),
    output: patchesSchema,
  },
});
