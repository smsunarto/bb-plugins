import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { vcsHandle, wireError, wireResult, wireValue } from "./wire.ts";

/**
 * The upstream modules the host entry runs, by facade name (design §3.1). The
 * allowlist in `src/host/lib/invoke.ts` lists the callable exports of each.
 *
 * - `local-vcs`: detectLocalVcs, diffFileSummariesTrees, diffFileSummariesWorkingTree,
 *   diffTrees, diffWorkingTree, gitCommonDir, git, listCommitRange,
 *   listTrackedFilesAtCommit, readFileAtCommit, resolveRepoContext and the rest
 *   of the closure's async exports
 * - `worktree-source`, `pull-request`: every async export
 * - `review-stack`: resolveReviewStackLayers (runs `gh api`)
 * - `review-branch-links`: resolveReviewBranchLinks
 * - `review-head-checkout`: ensureReviewPinnedCheckout
 * - `fs`: realpath, stat, readFile, writeFile, mkdir, exists, execFile
 */
export const HOST_MODULES = [
  "local-vcs",
  "worktree-source",
  "pull-request",
  "review-stack",
  "review-branch-links",
  "review-head-checkout",
  "fs",
] as const;
export type HostModule = (typeof HOST_MODULES)[number];

/** Every method of upstream `LocalVcs` (local-vcs/src/index.ts:46-71). */
export const VCS_METHODS = [
  "currentHead",
  "resolveRevision",
  "defaultBranch",
  "mergeBase",
  "listTrackedFiles",
  "readFileAtRef",
  "diff",
  "diffNameStatus",
  "diffFileSummaries",
  "githubRemoteSlug",
] as const;
export type VcsMethod = (typeof VCS_METHODS)[number];

/** The host worker rejects JSON above 8 MiB. Entries answer PayloadTooLarge above this. */
export const HOST_PAYLOAD_LIMIT_BYTES = 7 * 1024 * 1024;
/** Host hop timeouts (design §3.1). */
export const HOST_TIMEOUT_MS = { default: 30_000, diff: 120_000, long: 600_000 } as const;

export const whiteboardHostContract = defineRpcContract({
  /** One allowlisted async export. Args and results use the wire codec. */
  invoke: {
    input: z.strictObject({
      module: z.enum(HOST_MODULES),
      fn: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
      args: z.array(wireValue).max(16),
    }),
    output: wireResult,
  },
  /** A method on a LocalVcs object. The host rehydrates the handle (cached per rootPath). */
  vcsCall: {
    input: z.strictObject({
      vcs: vcsHandle,
      method: z.enum(VCS_METHODS),
      args: z.array(wireValue).max(8),
    }),
    output: wireResult,
  },
  /** Batched blob reads over the vendored blob-batch-reader. */
  readBlobs: {
    input: z.strictObject({
      rootPath: z.string().min(1).max(4096),
      kind: z.enum(["git", "jj"]),
      items: z.array(z.strictObject({ commit: z.string(), path: z.string() })).max(2000),
    }),
    /** `bytes` is base64, or null when the blob is absent. */
    output: z.object({ items: z.array(z.object({ bytes: z.string().nullable() })) }),
  },
  /** Start a diffr run. Events arrive as `structuralEvents` signals. Resolves when the run ends. */
  structuralDiff: {
    input: z.strictObject({
      streamId: z.uuid(),
      repositoryPath: z.string().min(1),
      comparison: z.strictObject({
        kind: z.enum(["trees", "merge-base"]),
        base: z.string(),
        head: z.string(),
      }),
      paths: z.array(z.string()).optional(),
    }),
    output: z.object({ ok: z.boolean(), error: wireError.optional() }),
  },
  cancelStructuralDiff: {
    input: z.strictObject({ streamId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  watchWorktree: {
    input: z.strictObject({ watchId: z.string(), rootPath: z.string().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
  unwatchWorktree: {
    input: z.strictObject({ watchId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  probe: {
    input: z.strictObject({}),
    output: z.object({
      platform: z.string(),
      git: z.boolean(),
      jj: z.boolean(),
      gh: z.boolean(),
      /** The diffr executable found, or null for the textual fallback. */
      diffr: z.string().nullable(),
    }),
  },
});
export type WhiteboardHostContract = typeof whiteboardHostContract;

/** Host to server signals. The SDK wants `{ payload }` per signal. */
export const whiteboardHostSignals = {
  worktreeChanged: {
    payload: z.object({
      watchId: z.string(),
      rootPath: z.string(),
      kind: z.enum(["changed", "rescan-required", "watch-error"]),
    }),
  },
  /** Ordered batches, flushed every 50 ms or 256 KB. `done` marks the last batch. */
  structuralEvents: {
    payload: z.object({
      streamId: z.string(),
      seq: z.number().int().nonnegative(),
      /** StructuralDiffEvent wire records. */
      events: z.array(z.json()),
      done: z.boolean(),
      error: wireError.optional(),
    }),
  },
} as const;
export type WhiteboardHostSignals = typeof whiteboardHostSignals;

/** A host method's parsed input, as the handler receives it. */
export type HostInput<M extends keyof WhiteboardHostContract> = z.output<
  WhiteboardHostContract[M]["input"]
>;
/** A host method's result, as the handler returns it. */
export type HostOutput<M extends keyof WhiteboardHostContract> = z.input<
  WhiteboardHostContract[M]["output"]
>;
/** A signal payload, as the host emits it. */
export type HostSignalPayload<S extends keyof WhiteboardHostSignals> = z.input<
  WhiteboardHostSignals[S]["payload"]
>;
