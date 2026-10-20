import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseHistorySchema,
  branchNameSchema,
  butActionSchema,
  hostButActionResponseSchema,
  commitIdSchema,
  checkoutIdentitySchema,
  environmentPathSchema,
  hostCheckoutSchema,
  hostUnpublishedBranchesSchema,
  hostWorkspaceSchema,
  oplogSchema,
  observedCheckoutSchema,
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
  /** The server's current known paths and main origin, never supplied by the browser. */
  checkout: z
    .object({ paths: z.array(environmentPathSchema).max(100_000), origin: originSchema })
    .strict()
    .optional(),
});

export const gitbutlerHostContract = defineRpcContract({
  repositories: {
    input: target.strict(),
    output: repositoriesSchema,
  },
  repository: { input: target.strict(), output: resolvedRepositorySchema },
  checkoutIdentity: {
    input: target.strict(),
    output: z.object({ key: z.string(), identity: checkoutIdentitySchema }).strict(),
  },
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
    input: target
      .extend({
        action: butActionSchema,
        observed: observedCheckoutSchema.optional(),
        /** Where the server last saw the checkout. The write is refused anywhere else. */
        expectedCheckout: checkoutIdentitySchema.pick({ path: true, commonDir: true }).optional(),
      })
      .strict(),
    output: hostButActionResponseSchema,
  },
  prepareCheckoutChild: {
    input: target
      .extend({ observed: observedCheckoutSchema, kind: z.enum(["review", "conflicts"]) })
      .strict(),
    output: checkoutIdentitySchema,
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

/**
 * What the host says unasked. A repository a panel read lately is watched,
 * and `repositoryChanged` names the viewed checkouts whose board a change on
 * disk may have moved: all of them for a ref or GitButler's own state, one
 * for its own HEAD or index.
 */
export const gitbutlerHostSignals = {
  repositoryChanged: {
    payload: z
      .object({
        commonDir: environmentPathSchema,
        checkouts: z.array(environmentPathSchema).max(1_000),
      })
      .strict(),
  },
} as const;
