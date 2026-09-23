import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { gitbutlerHostContract } from "../shared/host-contract.ts";
import type { Workspace, WorkspaceState } from "../shared/schema.ts";
import { ButMissingError, ButSetupRequiredError, runBut } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import { parseCommitDetails, parseWorkspace, patchFor } from "./parse.ts";
import { listRepositories, NoRepositoryError, resolveRepository } from "./repositories.ts";

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

function emptyWorkspace(state: WorkspaceState, reason: string): Workspace {
  return {
    state,
    reason,
    repoName: "",
    unassignedChanges: [],
    stacks: [],
    base: null,
    upstream: null,
    revision: `${state}:${reason}`,
  };
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

    async workspace({ environmentPath, repositoryKey }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
        // One call carries the whole panel. `-u` attaches the upstream commits
        // that are not integrated yet; per-commit files come from `commit`.
        const payload = await runBut(repository.path, ["status", "-u"], context.signal);
        return parseWorkspace(payload, repository.name);
      } catch (error) {
        if (context.signal.aborted) throw error;
        const { state, reason } = unavailable(error);
        return emptyWorkspace(state, reason);
      }
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

    async commit({ environmentPath, repositoryKey, commitId }, context) {
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      const payload = await runBut(repository.path, ["show", commitId], context.signal);
      return parseCommitDetails(payload, commitId);
    },

    async patch({ environmentPath, repositoryKey, source, path }, context) {
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      const payload = await runBut(
        repository.path,
        source.kind === "commit" ? ["diff", source.commitId] : ["diff"],
        context.signal,
      );
      const found = patchFor(payload, path, MAX_PATCH_CHARS);
      if (!found) return { path, patch: "", truncated: false };
      return { path, ...found };
    },
  },
});
