import path from "node:path";
import { HOST_TIMEOUT_MS } from "../../../shared/contracts/host-contract.ts";
import type * as upstream from "../../../shared/node/vendor/local-vcs/src/index.ts";
import type { RepoContext } from "../../../shared/node/vendor/local-vcs/src/index.ts";
import { createHostBlobReader, isHostBlobReader } from "./blob-reader.ts";
import { type HostRoute, invokeHost, invokeOn, isPayloadTooLarge, rememberPath } from "./client.ts";
import { concatenateByPaths } from "./payload-split.ts";

/**
 * Server facade for `@dev.fast/local-vcs` (design §3.1). Same export names and
 * signatures as upstream; git runs on the bb host that owns the checkout.
 * Pure helpers are re-exported with no hop.
 */
export type {
  BlobBatchReader,
  DiffNameStatus,
  LocalVcs,
  LocalVcsCommitSummary,
  LocalVcsDiffFileSummary,
  LocalVcsKind,
  NameStatus,
  ParsedGitRemote,
  RepoContext,
  ResolvedRevision,
} from "../../../shared/node/vendor/local-vcs/src/index.ts";
export {
  LocalVcsToolsMissingError,
  parseGitRemote,
  parseGitRemoteSlug,
  splitGitPatchFiles,
} from "../../../shared/node/vendor/local-vcs/src/index.ts";

const at = (rootPath: string): HostRoute => ({ rootPath });
const diffTimeout = { timeoutMs: HOST_TIMEOUT_MS.diff };

export const detectLocalVcs: typeof upstream.detectLocalVcs = async (rootPath) =>
  (await invokeHost("local-vcs", "detectLocalVcs", [rootPath], at(rootPath))) as Awaited<
    ReturnType<typeof upstream.detectLocalVcs>
  >;

export const gitCommonDir: typeof upstream.gitCommonDir = async (rootPath) => {
  const { value, hostId } = await invokeOn("local-vcs", "gitCommonDir", [rootPath], at(rootPath));
  rememberPath(value as string | null, hostId);
  return value as string | null;
};

/**
 * `resolveRepoContextSync` answers from this cache, which `resolveRepoContext`
 * fills. Keys are resolved paths, as upstream keys its lookups.
 */
const repoContexts = new Map<string, RepoContext | null>();

export const resolveRepoContext: typeof upstream.resolveRepoContext = async (rootPath) => {
  const key = path.resolve(rootPath);
  const { value, hostId } = await invokeOn("local-vcs", "resolveRepoContext", [key], at(key));
  const context = value as RepoContext | null;
  repoContexts.set(key, context);
  rememberPath(context?.commonDir, hostId);
  return context;
};

/**
 * Served from the repo-context cache the async facade primes. A miss answers
 * null and starts a prime, so the next read has it (`store.ts` does not
 * memoize a miss).
 */
export const resolveRepoContextSync: typeof upstream.resolveRepoContextSync = (rootPath) => {
  const key = path.resolve(rootPath);
  if (repoContexts.has(key)) return repoContexts.get(key)!;
  void resolveRepoContext(key).catch(() => {});
  return null;
};

/** Forget cached repo contexts (a re-registered or removed checkout). */
export function forgetRepoContext(rootPath?: string): void {
  if (rootPath === undefined) repoContexts.clear();
  else repoContexts.delete(path.resolve(rootPath));
}

export const createBlobBatchReader: typeof upstream.createBlobBatchReader = (input) =>
  createHostBlobReader({ rootPath: input.rootPath, kind: input.kind });

export const git: typeof upstream.git = async (rootPath, args, options = {}) => {
  const { signal, ...rest } = options;
  return (await invokeHost("local-vcs", "git", [rootPath, args, rest], at(rootPath), {
    timeoutMs: HOST_TIMEOUT_MS.diff,
    ...(signal ? { signal } : {}),
  })) as Awaited<ReturnType<typeof upstream.git>>;
};

export const diff: typeof upstream.diff = async (input) => {
  try {
    return (await invokeHost(
      "local-vcs",
      "diff",
      [input],
      at(input.rootPath),
      diffTimeout,
    )) as string;
  } catch (error) {
    if (!isPayloadTooLarge(error) || input.nameOnly) throw error;
    const vcs = await detectLocalVcs(input.rootPath);
    if (!vcs) throw error;
    const files = await vcs.diffFileSummaries({
      base: input.baseRef,
      head: input.headRef,
      paths: input.paths,
    });
    return concatenateByPaths(
      files,
      async (paths) =>
        (await invokeHost(
          "local-vcs",
          "diff",
          // Paths from the summaries are exact names, not pathspec patterns.
          [{ ...input, paths, literalPaths: true }],
          at(input.rootPath),
          diffTimeout,
        )) as string,
    );
  }
};

export const diffTrees: typeof upstream.diffTrees = async (input) => {
  try {
    return (await invokeHost(
      "local-vcs",
      "diffTrees",
      [input],
      at(input.rootPath),
      diffTimeout,
    )) as string;
  } catch (error) {
    if (!isPayloadTooLarge(error)) throw error;
    const files = await diffFileSummariesTrees({
      rootPath: input.rootPath,
      baseRef: input.baseRef,
      headRef: input.headRef,
      paths: input.paths,
      kind: input.kind,
    });
    return concatenateByPaths(
      files,
      async (paths) =>
        (await invokeHost(
          "local-vcs",
          "diffTrees",
          [{ ...input, paths, literalPaths: true }],
          at(input.rootPath),
          diffTimeout,
        )) as string,
    );
  }
};

export const diffWorkingTree: typeof upstream.diffWorkingTree = async (input) => {
  try {
    return (await invokeHost(
      "local-vcs",
      "diffWorkingTree",
      [input],
      at(input.rootPath),
      diffTimeout,
    )) as string;
  } catch (error) {
    if (!isPayloadTooLarge(error)) throw error;
    const all = await diffFileSummariesWorkingTree({
      rootPath: input.rootPath,
      kind: input.kind,
      baseRef: input.baseRef,
      headRef: input.headRef,
    });
    const wanted = input.paths && new Set(input.paths);
    const files = wanted
      ? all.filter((file) => wanted.has(file.path) || wanted.has(file.previousPath ?? ""))
      : all;
    return concatenateByPaths(
      files,
      async (paths) =>
        (await invokeHost(
          "local-vcs",
          "diffWorkingTree",
          [{ ...input, paths }],
          at(input.rootPath),
          diffTimeout,
        )) as string,
    );
  }
};

export const diffFileSummariesTrees: typeof upstream.diffFileSummariesTrees = async (input) =>
  (await invokeHost(
    "local-vcs",
    "diffFileSummariesTrees",
    [input],
    at(input.rootPath),
    diffTimeout,
  )) as Awaited<ReturnType<typeof upstream.diffFileSummariesTrees>>;

export const diffFileSummariesWorkingTree: typeof upstream.diffFileSummariesWorkingTree = async (
  input,
) =>
  (await invokeHost(
    "local-vcs",
    "diffFileSummariesWorkingTree",
    [input],
    at(input.rootPath),
    diffTimeout,
  )) as Awaited<ReturnType<typeof upstream.diffFileSummariesWorkingTree>>;

export const listCommitRange: typeof upstream.listCommitRange = async (input) =>
  (await invokeHost(
    "local-vcs",
    "listCommitRange",
    [input],
    at(input.rootPath),
    diffTimeout,
  )) as Awaited<ReturnType<typeof upstream.listCommitRange>>;

export const listTrackedFilesAtCommit: typeof upstream.listTrackedFilesAtCommit = async (input) =>
  (await invokeHost(
    "local-vcs",
    "listTrackedFilesAtCommit",
    [input],
    at(input.rootPath),
  )) as string[];

/**
 * With the facade's batched reader, a Git blob read goes through `readBlobs`
 * (upstream `readFileWithReader` for Git: the blob as UTF-8, else null). jj,
 * whose conflicted commits need `jj file show`, reads on the host in one call.
 */
export const readFileAtCommit: typeof upstream.readFileAtCommit = async (input) => {
  const { reader, ...rest } = input;
  if (reader && input.kind === "git" && isHostBlobReader(reader)) {
    const answer = await reader
      .readObject(input.commit, input.relativePath)
      .catch(() => ({ found: "nothing" }) as const);
    return answer.found === "blob" ? answer.blob.toString("utf8") : null;
  }
  return (await invokeHost("local-vcs", "readFileAtCommit", [rest], at(input.rootPath))) as
    | string
    | null;
};
