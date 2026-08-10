import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
  failedToSpawn: boolean;
  timedOut: boolean;
};

type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export type WorkspaceKeyResult =
  | { key: string; error: null }
  | { key: null; error: string };

// A worktree path is not a safe lock identity: linked worktrees share refs
// and gh-stack metadata. Fail closed unless Git identifies the common dir.
export async function resolveWorkspaceKey(
  cwd: string,
  runGit: GitRunner,
): Promise<WorkspaceKeyResult> {
  const result = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (result.code !== 0 || !result.stdout.trim()) {
    const reason = result.failedToSpawn
      ? "The git CLI was not found on the BB server host."
      : result.timedOut
        ? "Git timed out while identifying the repository common directory."
        : result.stderr.trim().split("\n").pop() ||
          "Git could not identify the repository common directory.";
    return { key: null, error: reason };
  }
  try {
    return {
      key: realpathSync(resolvePath(cwd, result.stdout.trim())),
      error: null,
    };
  } catch {
    return {
      key: null,
      error: "Git's repository common directory does not exist on the BB server host.",
    };
  }
}
