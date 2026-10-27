import { createHash } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { gitbutlerHostContract, gitbutlerHostSignals } from "../shared/host-contract.ts";
import type {
  ButActionResult,
  HostCheckout,
  HostWorkspace,
  WorkspaceState,
} from "../shared/schema.ts";
import { runAction } from "./actions.ts";
import { readParkedBranches } from "./branches.ts";
import { ButFailedError, ButMissingError, ButSetupRequiredError, runBut, runGit } from "./cli.ts";
import { describeBlob, readBlobChunk } from "./blobs.ts";
import { readBaseHistory, readCheckoutHead } from "./history.ts";
import { prepareGitCheckoutChild, runGitAction } from "./git-actions.ts";
import { readGitCheckout, readGitPatches, readGitWorkspace } from "./git-workspace.ts";
import { readOrigin } from "./origin.ts";
import { changed, forget, keepWatching, remember, share } from "./repository-state.ts";
import { readUnpublished } from "./unpublished.ts";
import { compareWithRemotes } from "./upstream.ts";
import {
  parseOplog,
  parseReviews,
  parseWorkspace,
  patchesFor,
  patchesFromGit,
  reviewUrl,
  uncommittedKinds,
} from "./parse.ts";
import {
  findCheckouts,
  findBranchCheckouts,
  inBatches,
  isKnownWorkspace,
  listRepositories,
  NoRepositoryError,
  resolveRepository,
  resolveKnownCheckout,
} from "./repositories.ts";

const MAX_PATCH_CHARS = 1_500_000;

type HostTarget = {
  environmentPath: string;
  repositoryKey?: string;
  checkout?: { paths: string[]; origin: string };
};

async function resolveHostRepository(input: HostTarget, signal: AbortSignal) {
  if (input.checkout) {
    if (input.repositoryKey && input.repositoryKey !== ".")
      throw new NoRepositoryError("Choose a repository within the selected checkout again.");
    return resolveKnownCheckout(input.environmentPath, input.checkout, signal);
  }
  return resolveRepository(input.environmentPath, input.repositoryKey, signal);
}

/**
 * Which kind of checkout a read is in, remembered for a few seconds. Writes
 * check a fresh one, and forget this.
 */
function checkoutOf(path: string, signal: AbortSignal) {
  return remember(`checkout\0${path}`, signal, (shared) => readGitCheckout(path, shared));
}

/**
 * Another plugin names the path, so only a GitButler workspace bb knows here
 * is read. A preview reads a file in several calls, so the answer is kept for
 * a few seconds, and a path bb knows directly skips the search below the rest.
 */
async function requireKnownWorkspace(
  within: readonly string[],
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const paths = createHash("sha256").update(within.join("\0")).digest("hex");
  const known = await remember(`known-workspace\0${path}\0${paths}`, signal, (shared) =>
    isKnownWorkspace(within.includes(path) ? [path] : within, path, shared),
  );
  if (!known)
    throw new NoRepositoryError("That is not a GitButler workspace bb knows on this machine.");
}

/** Classify a failure so the panel can explain it instead of showing a stack. */
function unavailable(error: unknown): { state: WorkspaceState; reason: string } {
  if (error instanceof ButMissingError) return { state: "cliMissing", reason: error.message };
  if (error instanceof ButSetupRequiredError) {
    return { state: "setupRequired", reason: error.message };
  }
  if (error instanceof NoRepositoryError) return { state: "noRepository", reason: error.message };
  return { state: "error", reason: error instanceof Error ? error.message : String(error) };
}

function emptyWorkspace(
  state: WorkspaceState,
  reason: string,
  repositoryKey: string | null,
): HostWorkspace {
  return {
    state,
    reason,
    repositoryKey,
    repoName: "",
    unassignedChanges: [],
    stacks: [],
    base: null,
    upstream: null,
    conflictedFiles: [],
  };
}

/** The board of one repository, or why there is none. */
async function readWorkspace(
  repository: { key: string; name: string; path: string },
  signal: AbortSignal,
): Promise<HostWorkspace> {
  try {
    const identity = await checkoutOf(repository.path, signal);
    if (identity.kind === "git") return await readGitWorkspace(repository, signal);
    // One call carries the whole panel. `-u` attaches the upstream commits
    // that are not integrated yet; per-commit files come from `patches`.
    const payload = await runBut(repository.path, ["status", "-u"], signal);
    const workspace = {
      ...parseWorkspace(payload, repository.name, repository.key),
      checkoutIdentity: identity,
    };
    // Without the comparison the cards keep GitButler's own labels.
    return await compareWithRemotes(repository.path, workspace, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return workspace;
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const { state, reason } = unavailable(error);
    return emptyWorkspace(state, reason, repository.key);
  }
}

type Repository = { key: string; name: string; path: string };

/** A board, read once for every caller asking while it is read. */
function boardOf(repository: Repository, signal: AbortSignal): Promise<HostWorkspace> {
  const key = `board\0${repository.path}\0${repository.key}\0${repository.name}`;
  return share(key, signal, (shared) => readWorkspace(repository, shared));
}

type Context = ExperimentalHostRpcContext<typeof gitbutlerHostSignals>;

/**
 * The board a panel is looking at. Reading it keeps its repository watched
 * for a while, so the panel hears of the next change instead of polling.
 */
async function readBoard(repository: Repository, context: Context): Promise<HostWorkspace> {
  const board = await boardOf(repository, context.signal);
  if (board.checkoutIdentity) {
    await keepWatching(board.checkoutIdentity, context).catch(() => undefined);
  }
  return board;
}

/**
 * One commit's patches from git. The reader's git config can change the
 * headers the parser reads paths from, so they are pinned.
 */
function showCommit(repositoryPath: string, commitId: string, signal: AbortSignal) {
  return runGit(
    repositoryPath,
    [
      "-c",
      "core.quotePath=false",
      "show",
      "--format=",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--submodule=short",
      "-M",
      "--diff-merges=first-parent",
      commitId,
      "--",
    ],
    signal,
  );
}

/**
 * Everything `head` changes since `base`, from git, with the same pinned
 * headers as {@link showCommit}.
 */
function diffRange(repositoryPath: string, base: string, head: string, signal: AbortSignal) {
  return runGit(
    repositoryPath,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--submodule=short",
      "-M",
      base,
      head,
      "--",
    ],
    signal,
  );
}

/**
 * The last action queued on each shared Git directory. Linked checkouts and
 * the main GitButler workspace share refs, so they share this queue. An action's
 * checks (the fetch, a dry run, the upstream-loss check) only hold until
 * another write lands, and separate panels and browsers each send their own,
 * so the host runs one repository's actions one at a time, checks included.
 */
const actionQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(repositoryPath: string, action: () => Promise<T>): Promise<T> {
  const result = (actionQueues.get(repositoryPath) ?? Promise.resolve()).then(action);
  // A failed action still frees the repository, and the last one out removes its entry.
  const queue: Promise<unknown> = result
    .catch(() => undefined)
    .finally(() => {
      if (actionQueues.get(repositoryPath) === queue) actionQueues.delete(repositoryPath);
    });
  actionQueues.set(repositoryPath, queue);
  return result;
}

/**
 * Runs a write after the ones queued before it, on what is there then:
 * nothing remembered from before the write is trusted, during it or after.
 */
function write<T>(commonDir: string, action: () => Promise<T>): Promise<T> {
  return oneAtATime(commonDir, async () => {
    forget();
    try {
      return await action();
    } finally {
      forget();
    }
  });
}

export default experimental_defineHostEntry({
  contract: gitbutlerHostContract,
  experimental_signals: gitbutlerHostSignals,
  handlers: {
    async repositories(input, context) {
      try {
        if (input.checkout) {
          const repository = await resolveHostRepository(input, context.signal);
          return { repositories: [{ key: repository.key, name: repository.name }], reason: null };
        }
        return {
          repositories: await listRepositories(input.environmentPath, context.signal),
          reason: null,
        };
      } catch (error) {
        return { repositories: [], reason: unavailable(error).reason };
      }
    },

    async repository(input, context) {
      const { key, path } = await resolveHostRepository(input, context.signal);
      return { key, path };
    },

    async checkoutIdentity(input, context) {
      const { key, path } = await resolveHostRepository(input, context.signal);
      return { key, identity: await readGitCheckout(path, context.signal) };
    },

    async workspace(input, context) {
      let repository;
      try {
        repository = await resolveHostRepository(input, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        const { state, reason } = unavailable(error);
        return emptyWorkspace(state, reason, null);
      }
      return readBoard(repository, context);
    },

    async origin(input, context) {
      const { path } = await resolveHostRepository(input, context.signal);
      return { path, origin: await readOrigin(path, context.signal) };
    },

    async checkouts({ paths, origin }, context) {
      const repositories = await findBranchCheckouts(paths, origin, context.signal);
      const checkouts = await inBatches(repositories, async (repository): Promise<HostCheckout> => {
        if (repository.kind === "git") {
          try {
            return {
              path: repository.path,
              state: "ready",
              reason: null,
              stacks: [],
              gitBranch: {
                name: repository.branch,
                head: await readCheckoutHead(repository.path, repository.branch, context.signal),
              },
            };
          } catch (error) {
            if (context.signal.aborted) throw error;
            return { path: repository.path, ...unavailable(error), stacks: [] };
          }
        }
        const { state, reason, stacks } = await boardOf(repository, context.signal);
        return { path: repository.path, state, reason, stacks };
      });
      return { checkouts };
    },

    async unpublishedBranches({ paths, path }, context) {
      if (path) {
        const repository = await resolveRepository(path, undefined, context.signal);
        if (
          !(await isKnownWorkspace(
            paths.includes(path) ? [path] : paths,
            repository.path,
            context.signal,
          ))
        )
          throw new NoRepositoryError(
            "That is not a GitButler workspace bb knows on this machine.",
          );
        return {
          branches: await readUnpublished(
            { ...repository, origin: await readOrigin(repository.path, context.signal) },
            context.signal,
          ),
        };
      }
      const repositories = await findCheckouts(paths, null, context.signal);
      const found = await Promise.all(
        repositories.map((repository) =>
          // One workspace that cannot be read leaves the others standing.
          readUnpublished(repository, context.signal).catch((error: unknown) => {
            if (context.signal.aborted) throw error;
            return [];
          }),
        ),
      );
      return { branches: found.flat() };
    },

    async baseHistory(input, context) {
      const { from, offset, limit } = input;
      try {
        const repository = await resolveHostRepository(input, context.signal);
        const page = await readBaseHistory(repository.path, from, offset, limit, context.signal);
        return { ...page, reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { commits: [], hasMore: false, reason: unavailable(error).reason };
      }
    },

    async patches(input, context) {
      const { source } = input;
      const repository = await resolveHostRepository(input, context.signal);
      if (source.kind === "range") {
        // Another plugin names the path, so only a workspace bb knows here is read.
        if (!(await isKnownWorkspace(source.within, repository.path, context.signal))) {
          throw new NoRepositoryError(
            "That is not a GitButler workspace bb knows on this machine.",
          );
        }
        const output = await diffRange(repository.path, source.base, source.head, context.signal);
        return patchesFromGit(output, MAX_PATCH_CHARS);
      }
      if ((await checkoutOf(repository.path, context.signal)).kind === "git") {
        return readGitPatches(repository.path, source, context.signal);
      }
      if (source.kind === "uncommitted") {
        const [payload, status] = await Promise.all([
          runBut(repository.path, ["diff"], context.signal),
          // Only the kinds come from here, so the diff still shows without them.
          runBut(repository.path, ["status"], context.signal).catch(() => null),
        ]);
        return patchesFor(payload, MAX_PATCH_CHARS, status ? uncommittedKinds(status) : undefined);
      }
      // `but diff` resolves only workspace commits. The common base and the
      // target history are plain git, so a commit the panel knows is there
      // skips the `but` call that would fail.
      if (source.where === undefined) {
        try {
          const payload = await runBut(repository.path, ["diff", source.commitId], context.signal);
          return patchesFor(payload, MAX_PATCH_CHARS);
        } catch (error) {
          if (context.signal.aborted || !(error instanceof ButFailedError)) throw error;
        }
      }
      const output = await showCommit(repository.path, source.commitId, context.signal);
      return patchesFromGit(output, MAX_PATCH_CHARS);
    },

    async blobs(input, context) {
      const repository = await resolveHostRepository(input, context.signal);
      await requireKnownWorkspace(input.within, repository.path, context.signal);
      const items = await Promise.all(
        input.items.map(({ rev, path }) =>
          describeBlob(repository.path, rev, path, context.signal),
        ),
      );
      return { items };
    },

    async blobChunk(input, context) {
      const repository = await resolveHostRepository(input, context.signal);
      await requireKnownWorkspace(input.within, repository.path, context.signal);
      return readBlobChunk(
        repository.path,
        input.object,
        input.offset,
        input.length,
        context.signal,
      );
    },

    async prepareCheckoutChild(input, context) {
      const repository = await resolveHostRepository(input, context.signal);
      const initial = await checkoutOf(repository.path, context.signal);
      return write(initial.commonDir, async () => {
        const current = await resolveHostRepository(input, context.signal);
        const identity = await readGitCheckout(current.path, context.signal);
        if (
          identity.commonDir !== initial.commonDir ||
          identity.kind !== initial.kind ||
          identity.origin !== initial.origin
        ) {
          throw new NoRepositoryError("The checkout changed while waiting. Refresh the board.");
        }
        return prepareGitCheckoutChild(current.path, input.kind, input.observed, context.signal);
      });
    },

    async butAction(input, context) {
      const { action } = input;
      const repository = await resolveHostRepository(input, context.signal);
      const initial = await checkoutOf(repository.path, context.signal);
      let outcome: ButActionResult | undefined;
      const { current, result } = await write(initial.commonDir, async () => {
        const current = await resolveHostRepository(input, context.signal);
        const identity = await readGitCheckout(current.path, context.signal);
        if (
          identity.commonDir !== initial.commonDir ||
          identity.kind !== initial.kind ||
          identity.origin !== initial.origin
        ) {
          throw new NoRepositoryError("The checkout changed while waiting. Refresh the board.");
        }
        const expected = input.expectedCheckout;
        if (
          expected &&
          (identity.path !== expected.path || identity.commonDir !== expected.commonDir)
        ) {
          throw new NoRepositoryError(
            "The checkout moved since the board was read. Refresh the board.",
          );
        }
        if (identity.kind === "git" && !input.observed)
          throw new NoRepositoryError("Refresh the isolated checkout before running an action.");
        try {
          if (identity.kind === "git" && input.observed) {
            outcome = await runGitAction(current.path, action, context.signal, input.observed);
          } else {
            outcome = await runAction(current.path, action, context.signal);
          }
          return { current, result: outcome };
        } finally {
          // Even a failed action may have written. A question wrote nothing.
          if (outcome?.status !== "confirm") void changed(initial.commonDir, context);
        }
      });
      // A question changed nothing. Anything else hands back the board it
      // left, read after the queue so the next write need not wait for it.
      if (result.status === "confirm") return { result, board: null };
      return { result, board: await readBoard(current, context) };
    },

    async reviewUrl(input, context) {
      const { branch } = input;
      const repository = await resolveHostRepository(input, context.signal);
      if ((await checkoutOf(repository.path, context.signal)).kind === "git") return { url: null };
      // `-r` asks the forge, so this runs when the reader opens a review, never on a poll.
      const payload = await runBut(
        repository.path,
        ["branch", "show", branch, "-r"],
        context.signal,
      );
      return { url: reviewUrl(payload) };
    },

    async reviews(input, context) {
      try {
        const repository = await resolveHostRepository(input, context.signal);
        if ((await checkoutOf(repository.path, context.signal)).kind === "git")
          return { reviews: [], reason: null };
        // `--review` can ask the forge, so this is read apart from the
        // workspace and never holds it up. Checks and counts are skipped.
        const payload = await runBut(
          repository.path,
          ["branch", "list", "--local", "--review", "--no-check", "--no-ahead"],
          context.signal,
        );
        return { reviews: parseReviews(payload), reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { reviews: [], reason: unavailable(error).reason };
      }
    },

    async oplog(input, context) {
      try {
        const repository = await resolveHostRepository(input, context.signal);
        if ((await checkoutOf(repository.path, context.signal)).kind === "git")
          return { entries: [], reason: null };
        const payload = await runBut(repository.path, ["oplog", "list"], context.signal);
        return { entries: parseOplog(payload), reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { entries: [], reason: unavailable(error).reason };
      }
    },

    async parkedBranches(input, context) {
      try {
        const repository = await resolveHostRepository(input, context.signal);
        if ((await checkoutOf(repository.path, context.signal)).kind === "git")
          return { branches: [], hasMore: false, reason: null };
        const parked = await readParkedBranches(repository.path, context.signal);
        return { ...parked, reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { branches: [], hasMore: false, reason: unavailable(error).reason };
      }
    },
  },
});
