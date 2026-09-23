import type { BaseCommit } from "../shared/schema.ts";
import { runGit } from "./cli.ts";
import { parseGitLog } from "./parse.ts";

/** NUL-delimited so a subject containing any printable character survives. */
const FORMAT = "--format=%H%x00%an%x00%aI%x00%s%x00%x00";

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
