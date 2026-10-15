import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseHistorySchema,
  branchNameSchema,
  butActionResultSchema,
  butActionSchema,
  commitIdSchema,
  environmentPathSchema,
  hostCheckoutSchema,
  hostUnpublishedBranchesSchema,
  hostWorkspaceSchema,
  oplogSchema,
  originSchema,
  parkedBranchesSchema,
  patchesSchema,
  patchSourceSchema,
  rangeSourceSchema,
  repositoriesSchema,
  repositoryKeySchema,
  repositoryOriginSchema,
  resolvedRepositorySchema,
  reviewsSchema,
  reviewUrlSchema,
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
  workspace: { input: target.strict(), output: hostWorkspaceSchema },
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
    input: target.extend({ source: z.union([patchSourceSchema, rangeSourceSchema]) }).strict(),
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
  reviews: { input: target.strict(), output: reviewsSchema },
  oplog: { input: target.strict(), output: oplogSchema },
  parkedBranches: { input: target.strict(), output: parkedBranchesSchema },
  origin: { input: target.strict(), output: repositoryOriginSchema },
  /**
   * Matching-origin checkouts among bb's known paths and their registered
   * linked worktrees. GitButler workspaces retain their stacks; other named
   * Git checkouts expose only a read-only branch and latest commit.
   */
  checkouts: {
    input: z
      .object({ paths: z.array(environmentPathSchema).max(100_000), origin: originSchema })
      .strict(),
    output: z.object({ checkouts: z.array(hostCheckoutSchema) }).strict(),
  },
  /** The unpublished branches of every GitButler workspace among `paths`, whatever its origin. */
  unpublishedBranches: {
    input: z.object({ paths: z.array(environmentPathSchema).max(100_000) }).strict(),
    output: hostUnpublishedBranchesSchema,
  },
});
