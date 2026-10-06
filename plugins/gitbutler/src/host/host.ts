import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { gitbutlerHostContract } from "../shared/host-contract.ts";
import type { Workspace, WorkspaceState } from "../shared/schema.ts";
import { runAction } from "./actions.ts";
import { ButFailedError, ButMissingError, ButSetupRequiredError, runBut, runGit } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import { compareWithRemotes } from "./upstream.ts";
import {
  parseWorkspace,
  patchesFor,
  patchesFromGit,
  reviewUrl,
  uncommittedKinds,
} from "./parse.ts";
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
    conflictedFiles: [],
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

    async repository({ environmentPath, repositoryKey }, context) {
      const { key, path } = await resolveRepository(environmentPath, repositoryKey, context.signal);
      return { key, path };
    },

    async workspace({ environmentPath, repositoryKey }, context) {
      try {
        const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
        // One call carries the whole panel. `-u` attaches the upstream commits
        // that are not integrated yet; per-commit files come from `patches`.
        const payload = await runBut(repository.path, ["status", "-u"], context.signal);
        const workspace = parseWorkspace(payload, repository.name);
        // Without the comparison the cards keep GitButler's own labels.
        return await compareWithRemotes(repository.path, workspace, context.signal).catch(
          (error: unknown) => {
            if (context.signal.aborted) throw error;
            return workspace;
          },
        );
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
      try {
        const payload = await runBut(repository.path, ["diff", source.commitId], context.signal);
        return patchesFor(payload, MAX_PATCH_CHARS);
      } catch (error) {
        if (context.signal.aborted || !(error instanceof ButFailedError)) throw error;
        // `but diff` resolves only workspace commits. The common base and the
        // target history below it are plain git. The reader's git config can
        // change the headers the parser reads paths from, so they are pinned.
        const output = await runGit(
          repository.path,
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
            source.commitId,
            "--",
          ],
          context.signal,
        );
        return patchesFromGit(output, MAX_PATCH_CHARS);
      }
    },

    async butAction({ environmentPath, repositoryKey, action }, context) {
      const repository = await resolveRepository(environmentPath, repositoryKey, context.signal);
      return runAction(repository.path, action, context.signal);
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
  },
});
