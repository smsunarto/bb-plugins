import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseHistorySchema,
  blobDescriptorSchema,
  blobObjectSchema,
  blobPathSchema,
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

/** How long the host may spend fetching a Git LFS object a chunk names. */
export const LFS_DOWNLOAD_MS = 120_000;
/** A chunk's call allows that download, plus the read. */
export const BLOB_CHUNK_TIMEOUT_MS = LFS_DOWNLOAD_MS + 15_000;

export const gitbutlerHostContract = defineRpcContract({
  repositories: {
    experimental_retryable: true,
    input: target.strict(),
    output: repositoriesSchema,
  },
  repository: {
    experimental_retryable: true,
    input: target.strict(),
    output: resolvedRepositorySchema,
  },
  checkoutIdentity: {
    experimental_retryable: true,
    input: target.strict(),
    output: z.object({ key: z.string(), identity: checkoutIdentitySchema }).strict(),
  },
  workspace: { experimental_retryable: true, input: target.strict(), output: hostWorkspaceSchema },
  baseHistory: {
    experimental_retryable: true,
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
    experimental_retryable: true,
    input: target.extend({ source: z.union([patchSourceSchema, rangeSourceSchema]) }).strict(),
    output: patchesSchema,
  },
  /** What each path holds at its commit, in a workspace among `within`. */
  blobs: {
    input: target
      .extend({
        within: z.array(z.string()),
        items: z
          .array(z.object({ rev: commitIdSchema, path: blobPathSchema }).strict())
          .min(1)
          .max(8),
      })
      .strict(),
    output: z.object({ items: z.array(blobDescriptorSchema) }).strict(),
  },
  /** One range of a blob or LFS object, base64. LFS objects download into the checkout's store first. */
  blobChunk: {
    input: target
      .extend({
        within: z.array(z.string()),
        object: blobObjectSchema,
        offset: z.number().int().nonnegative(),
        length: z
          .number()
          .int()
          .min(1)
          .max(4 * 1024 * 1024),
      })
      .strict(),
    output: z.object({ size: z.number().int().nonnegative(), content: z.string() }).strict(),
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
  // Forge reads need the full transport budget instead of restarting halfway.
  reviewUrl: {
    input: target.extend({ branch: branchNameSchema }).strict(),
    output: reviewUrlSchema,
  },
  reviews: { input: target.strict(), output: reviewsSchema },
  oplog: { experimental_retryable: true, input: target.strict(), output: oplogSchema },
  parkedBranches: {
    experimental_retryable: true,
    input: target.strict(),
    output: parkedBranchesSchema,
  },
  origin: { experimental_retryable: true, input: target.strict(), output: repositoryOriginSchema },
  /**
   * Matching-origin checkouts among bb's known paths and their registered
   * linked worktrees. GitButler workspaces retain their stacks; other named
   * Git checkouts expose only a read-only branch and latest commit.
   * Scans keep the full timeout: a transport retry discards their progress.
   */
  checkouts: {
    input: z
      .object({ paths: z.array(environmentPathSchema).max(100_000), origin: originSchema })
      .strict(),
    output: z.object({ checkouts: z.array(hostCheckoutSchema) }).strict(),
  },
  /** The unpublished branches of every GitButler workspace among `paths`, whatever its origin. */
  unpublishedBranches: {
    input: z
      .object({
        paths: z.array(environmentPathSchema).max(100_000),
        path: environmentPathSchema.optional(),
      })
      .strict(),
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
