import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { gitbutlerHostContract } from "../shared/host-contract.ts";
import type { HostWorkspace, WorkspaceState } from "../shared/schema.ts";
import { runAction } from "./actions.ts";
import { readParkedBranches } from "./branches.ts";
import { ButFailedError, ButMissingError, ButSetupRequiredError, runBut, runGit } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import { readOrigin } from "./origin.ts";
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
  listRepositories,
  NoRepositoryError,
  resolveRepository,
} from "./repositories.ts";

const MAX_PATCH_CHARS = 1_500_000;

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
    // One call carries the whole panel. `-u` attaches the upstream commits
    // that are not integrated yet; per-commit files come from `patches`.
    const payload = await runBut(repository.path, ["status", "-u"], signal);
    const workspace = parseWorkspace(payload, repository.name, repository.key);
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
 * The last action queued on each repository, by its real path. An action's
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

export default experimental_defineHostEntry({
  contract: gitbutlerHostContract,
  handlers: {
    async repositories({ environmentPath }, context) {
      try {
        return {
          repositories: await listRepositories(environmentPath, context.signal),
          reason: null,
        };
      } catch (error) {
        return { repositories: [], reason: unavailable(error).reason };
      }
    },

    async repository({ environmentPath, repositoryKey }, context) {
      const { key, path } = await resolveRepository(environmentPath, repositoryKey, context.signal);
      return { key, path };
    },

    async workspace({ environmentPath, repositoryKey }, context) {
      let repository;
      try {
        repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      } catch (error) {
        if (context.signal.aborted) throw error;
        const { state, reason } = unavailable(error);
        return emptyWorkspace(state, reason, null);
      }
      return readWorkspace(repository, context.signal);
    },

    async origin({ environmentPath, repositoryKey }, context) {
      const { path } = await resolveRepository(environmentPath, repositoryKey, context.signal);
      return { path, origin: await readOrigin(path, context.signal) };
    },

    async checkouts({ paths, origin }, context) {
      const repositories = await findCheckouts(paths, origin, context.signal);
      const checkouts = await Promise.all(
        repositories.map(async (repository) => {
          const { state, reason, stacks } = await readWorkspace(repository, context.signal);
          return { path: repository.path, state, reason, stacks };
        }),
      );
      return { checkouts };
    },

    async baseHistory({ environmentPath, repositoryKey, from, offset, limit }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
        const page = await readBaseHistory(repository.path, from, offset, limit, context.signal);
        return { ...page, reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { commits: [], hasMore: false, reason: unavailable(error).reason };
      }
    },

    async patches({ environmentPath, repositoryKey, source }, context) {
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
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

    async butAction({ environmentPath, repositoryKey, action }, context) {
      // The path is the real one, so every spelling of one repository shares a queue.
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      return oneAtATime(repository.path, () => runAction(repository.path, action, context.signal));
    },

    async reviewUrl({ environmentPath, repositoryKey, branch }, context) {
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      // `-r` asks the forge, so this runs when the reader opens a review, never on a poll.
      const payload = await runBut(
        repository.path,
        ["branch", "show", branch, "-r"],
        context.signal,
      );
      return { url: reviewUrl(payload) };
    },

    async reviews({ environmentPath, repositoryKey }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
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

    async oplog({ environmentPath, repositoryKey }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
        const payload = await runBut(repository.path, ["oplog", "list"], context.signal);
        return { entries: parseOplog(payload), reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { entries: [], reason: unavailable(error).reason };
      }
    },

    async parkedBranches({ environmentPath, repositoryKey }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
        const parked = await readParkedBranches(repository.path, context.signal);
        return { ...parked, reason: null };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { branches: [], hasMore: false, reason: unavailable(error).reason };
      }
    },
  },
});
