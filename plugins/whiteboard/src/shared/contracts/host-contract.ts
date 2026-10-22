import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { vcsHandle, wireError, wireResult, wireValue } from "./wire.ts";

/** The upstream modules the host entry runs, by facade name (design §3.1). */
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

/**
 * The callable exports of each host module: what server facades may `invoke`,
 * and what the allowlist in `src/host/lib/invoke.ts` must implement.
 */
export const HOST_FUNCTION_NAMES = {
  "local-vcs": [
    "detectLocalVcs",
    "gitCommonDir",
    "resolveRepoContext",
    "git",
    "diff",
    "diffTrees",
    "diffWorkingTree",
    "diffFileSummariesTrees",
    "diffFileSummariesWorkingTree",
    "listCommitRange",
    "listTrackedFilesAtCommit",
    "readFileAtCommit",
  ],
  "worktree-source": [
    "localSourcePath",
    "workingFiles",
    "inspectWorktree",
    "retainedWorktreeTree",
    "retainedWorktreeHead",
    "pruneWorktreeTrees",
    "readWorkingFile",
  ],
  "pull-request": ["run"],
  "review-stack": ["resolveReviewStackLayers"],
  "review-branch-links": ["resolveReviewBranchLinks"],
  "review-head-checkout": ["ensureReviewPinnedCheckout"],
  fs: [
    "realpath",
    "stat",
    "lstat",
    "readFile",
    "readlink",
    "writeFile",
    "writePrivateJsonAtomic",
    "mkdir",
    "exists",
    "execFile",
  ],
} as const satisfies { readonly [M in HostModule]: readonly string[] };
export type HostFunctionName<M extends HostModule> = (typeof HOST_FUNCTION_NAMES)[M][number];

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
/**
 * Host hop timeouts (design §3.1). `probe` bounds the cheap questions a panel
 * or a cross-repository search waits on (tool probe, root exists, watch
 * liveness). bb adds 6 s of transport grace, and up to 5 s more while a
 * dropped host's lease runs out, so a host that stopped answering costs
 * about 11 to 16 s instead of 36 to 41 s.
 */
export const HOST_TIMEOUT_MS = {
  probe: 5_000,
  default: 30_000,
  diff: 120_000,
  long: 600_000,
} as const;

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
    /** A size failure belongs to one item; `bytes: null` means no blob. */
    output: z.object({
      items: z.array(
        z.union([
          z.object({ bytes: z.string().nullable() }),
          z.object({ error: z.enum(["reader-limit", "transfer-limit"]) }),
        ]),
      ),
    }),
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
    input: z.strictObject({
      watchId: z.string(),
      rootPath: z.string().min(1),
      /**
       * The repository's resolved Git common directory, which the server
       * watches as a root of its own. The host derives the root's ignored Git
       * bookkeeping from it (`ignoredGitPaths`). Absent, the host ignores nothing.
       */
      gitCommonDir: z.string().min(1).optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  unwatchWorktree: {
    input: z.strictObject({ watchId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Which of these watches the host still holds. A restarted daemon holds none. */
  watchAlive: {
    input: z.strictObject({ watchIds: z.array(z.string()).max(2000) }),
    output: z.object({ live: z.array(z.string()) }),
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
