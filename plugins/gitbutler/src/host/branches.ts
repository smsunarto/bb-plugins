import type { ParkedBranch } from "../shared/schema.ts";
import { runBut, runGit } from "./cli.ts";
import { parseParkedBranches, parseRefSubjects } from "./parse.ts";

/** Each field ended by a NUL, so no subject can run into the next branch's name. */
const SUBJECT_FORMAT = "--format=%(refname:lstrip=2)%00%(contents:subject)%00";

/**
 * The local branches not applied to the workspace, most recently updated
 * first. `--no-check` and `--no-ahead` skip a merge check and a count per
 * branch that the panel does not show.
 */
export async function readParkedBranches(
  repositoryPath: string,
  signal: AbortSignal,
): Promise<{ branches: ParkedBranch[]; hasMore: boolean }> {
  const payload = await runBut(
    repositoryPath,
    ["branch", "list", "--local", "--no-check", "--no-ahead"],
    signal,
  );
  const { branches, hasMore } = parseParkedBranches(payload);
  if (branches.length === 0) return { branches, hasMore };
  // `but` names no commit messages, so one git call reads every subject.
  // Each pattern starts with refs/, so no name can read as a flag.
  const subjects = await runGit(
    repositoryPath,
    ["for-each-ref", SUBJECT_FORMAT, ...branches.map((branch) => `refs/heads/${branch.name}`)],
    signal,
  )
    .then(parseRefSubjects)
    .catch((error: unknown) => {
      if (signal.aborted) throw error;
      return new Map<string, string>();
    });
  return {
    branches: branches.map(({ name, updatedAt }) => ({
      name,
      subject: subjects.get(name) ?? null,
      updatedAt,
    })),
    hasMore,
  };
}
