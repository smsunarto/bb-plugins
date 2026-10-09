import { instructionFiles } from "@bb-kit/core/instructions";

/*
 * What the subthreads the panel starts are told. The words live in
 * `instructions/`, and this fills in the commands.
 *
 * Git allows `;`, `$`, and backticks in branch names, and a path can hold
 * anything, so both only ever appear shell-quoted inside fenced commands,
 * never as prose.
 */

const files = instructionFiles(import.meta.url);

/**
 * What the PR subthread is told. The agent reads the branch, writes the
 * title and description, and lets GitButler push and open the review, so the
 * description is written by something that read the diff.
 */
export function reviewPrompt(branch: string, repositoryPath: string): string {
  const name = quote(branch);
  return files.read("create-pr", {
    show: fenced(`cd ${quote(repositoryPath)}\nbut show ${name}`),
    prNew: fenced(`but pr new ${name} -F <file>`),
  });
}

/**
 * What the conflict subthread is told. The agent resolves every conflict in
 * the workspace, commits and uncommitted files alike, so one subthread owns
 * the whole job: resolving a lower commit rebases the ones above it, and two
 * agents doing that side by side would rewrite each other's commits.
 *
 * It resolves with `but resolve apply`, not resolution mode, because the
 * subthread shares the parent thread's working tree and resolution mode would
 * swap it out from under that thread. GitButler 0.22.3 leaves some conflicts
 * to resolution mode only (deletions, renames, binary or oversized files), so
 * those go back to the user. The step order, the commit ids, and the warnings
 * about `apply` come from running this prompt against real conflicts in a
 * stack.
 */
export function conflictPrompt(repositoryPath: string): string {
  return files.read("resolve-conflicts", {
    status: fenced(`cd ${quote(repositoryPath)}\nbut status`),
  });
}

/** POSIX single quotes: nothing inside is expanded, and `'` is closed, escaped, and reopened. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A fence longer than any backtick run inside, so the content cannot close it. */
function fenced(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}sh\n${code}\n${fence}`;
}
