/**
 * The checkout host's entry: the plain-git workspace read, and GitHub reads
 * when this host is the forge site for a change.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { sourceControlHostContract, type HostFailure } from "../contract/host.ts";
import { execGh } from "../forge/exec-gh.ts";
import { GhError, readAccounts, readPullRequest } from "../forge/github.ts";
import { GitFailedError, GitMissingError, readWorkspace } from "./git.ts";

function ghFailure(error: unknown): HostFailure {
  if (error instanceof GhError) {
    const code = error.code === "gh-missing" ? "gh-missing" : error.code;
    return { code, message: error.message };
  }
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

export default experimental_defineHostEntry({
  contract: sourceControlHostContract,
  handlers: {
    async workspace({ path }, { signal }) {
      try {
        return { ok: true as const, value: await readWorkspace(path, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof GitMissingError)
          return {
            ok: false as const,
            error: { code: "git-missing" as const, message: error.message },
          };
        const message =
          error instanceof GitFailedError || error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: { code: "failed" as const, message } };
      }
    },
    async forgeAccounts(_input, { signal }) {
      try {
        return { ok: true as const, value: { accounts: await readAccounts(execGh, signal) } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeCall(operation, { signal }) {
      try {
        const { repo, headOwner, branch } = operation;
        return {
          ok: true as const,
          value: await readPullRequest(execGh, { repo, headOwner, branch }, signal),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
  },
});
