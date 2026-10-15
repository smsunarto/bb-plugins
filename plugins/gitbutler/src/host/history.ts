import type { BaseCommit } from "../shared/schema.ts";
import { runGit } from "./cli.ts";
import { parseGitLog } from "./parse.ts";

/**
 * NUL-delimited, with `-z` ending each record in one, so any message survives.
 * The whole message, not the subject: the commit's detail screen shows its body.
 */
const FORMAT = "--format=%H%x00%an%x00%aI%x00%B";

/** The named checkout's latest commit, including its full message; unborn branches have none. */
export async function readCheckoutHead(
  repositoryPath: string,
  branch: string,
  signal: AbortSignal,
): Promise<BaseCommit | null> {
  const refName = `refs/heads/${branch}`;
  const refs = await runGit(
    repositoryPath,
    ["for-each-ref", "--format=%(refname)%00%(objectname)", refName],
    signal,
  );
  // for-each-ref also matches descendants of its pattern; only the exact branch is HEAD.
  const ref = refs
    .split("\n")
    .map((line) => line.split("\0"))
    .find(([name]) => name === refName)?.[1];
  if (!ref) return null;
  const output = await runGit(
    repositoryPath,
    ["log", "-z", "--no-show-signature", FORMAT, "--max-count=1", ref, "--"],
    signal,
  );
  const [head] = parseGitLog(output);
  if (!head) throw new Error("The checkout's latest commit could not be read.");
  return head;
}

/**
 * The target-branch history strictly below the workspace's common base. The
 * base already has its own row in the panel, and `git log <base>` starts AT
 * the base, so the window is shifted by one.
 */
export async function readBaseHistory(
  repositoryPath: string,
  from: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<{ commits: BaseCommit[]; hasMore: boolean }> {
  const output = await runGit(
    repositoryPath,
    [
      "log",
      "-z",
      "--no-show-signature",
      FORMAT,
      `--skip=${offset + 1}`,
      `--max-count=${limit + 1}`,
      from,
      "--",
    ],
    signal,
  );
  const parsed = parseGitLog(output);
  return { commits: parsed.slice(0, limit), hasMore: parsed.length > limit };
}
