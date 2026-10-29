import type { Branch, UnpublishedBranch } from "../shared/schema.ts";
import { runBut, runGit } from "./cli.ts";
import { parseWorkspace } from "./parse.ts";

/** Has commits, has no review on the forge, and has not landed. */
function unpublished(branch: Branch): boolean {
  return branch.reviewId === null && branch.commits.length > 0 && branch.status !== "integrated";
}

/**
 * The workspace's unpublished branches. Each starts from its oldest commit's
 * parent, which git names in one call for all of them: below a stacked
 * branch that is the tip of the branch under it, and at the bottom, the
 * commit the stack sits on.
 */
export async function readUnpublished(
  repository: { name: string; key: string; path: string; origin: string | null },
  signal: AbortSignal,
): Promise<UnpublishedBranch[]> {
  const payload = await runBut(repository.path, ["status"], signal);
  const { stacks } = parseWorkspace(payload);
  // Branches run top to bottom in a stack, so the one under `i` is `i + 1`.
  const found = stacks.flatMap((stack) =>
    stack.branches.flatMap((branch, i) =>
      unpublished(branch) ? [{ branch, parent: stack.branches[i + 1]?.name ?? null }] : [],
    ),
  );
  if (found.length === 0) return [];
  const oldest = found.map(({ branch }) => `${branch.commits.at(-1)?.commitId}^`);
  const bases = (await runGit(repository.path, ["rev-parse", ...oldest], signal))
    .trim()
    .split("\n");
  return found.map(({ branch, parent }, i) => ({
    path: repository.path,
    repoName: repository.name,
    origin: repository.origin,
    branch: branch.name,
    status: branch.status,
    head: branch.commits[0]?.commitId ?? "",
    base: bases[i] ?? "",
    parent,
    commits: branch.commits,
  }));
}
