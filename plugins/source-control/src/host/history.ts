/**
 * The target's history under the workspace's common base. Ported from
 * `plugins/gitbutler/src/host/history.ts` (`readBaseHistory`).
 */
import type { BaseHistory } from "../core/history.ts";
import { runGit } from "./cli.ts";
import { GIT_LOG_FORMAT, parseGitLog } from "./parse.ts";

/**
 * The commits strictly below `from`, newest first. The base has its own row
 * in the card, and `git log <base>` starts at the base, so the window is
 * shifted by one; one more than asked says whether there are more.
 */
export async function readBaseHistory(
  repositoryPath: string,
  from: string,
  limit: number,
  signal: AbortSignal,
): Promise<BaseHistory> {
  const output = await runGit(
    repositoryPath,
    [
      "log",
      "-z",
      "--no-show-signature",
      GIT_LOG_FORMAT,
      "--skip=1",
      `--max-count=${limit + 1}`,
      from,
      "--",
    ],
    signal,
  );
  const parsed = parseGitLog(output);
  return {
    commits: parsed.slice(0, limit).map((commit) => ({
      id: commit.commitId,
      subject: commit.message.split("\n", 1)[0] ?? "",
      createdAt: commit.createdAt,
    })),
    hasMore: parsed.length > limit,
  };
}
