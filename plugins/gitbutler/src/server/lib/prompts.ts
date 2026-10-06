/*
 * What the subthreads the panel starts are told.
 *
 * Git allows `;`, `$`, and backticks in branch names, and a path can hold
 * anything, so both only ever appear shell-quoted inside fenced commands,
 * never as prose.
 */

/**
 * What the PR subthread is told. The agent reads the branch, writes the
 * title and description, and lets GitButler push and open the review, so the
 * description is written by something that read the diff.
 */
export function reviewPrompt(branch: string, repositoryPath: string): string {
  const name = quote(branch);
  return [
    "Open a pull request for one GitButler branch. Run these from the repository, exactly as quoted:",
    "",
    fenced(`cd ${quote(repositoryPath)}\nbut show ${name}`),
    "",
    "1. Read what the branch changes: the output above, then the diff of each of its commits.",
    "2. Write a PR title and a description for a reviewer: what changed, why, and anything they should check. Follow the repository's PR template if it has one.",
    "3. Write the title on the first line of a temporary file and the description after a blank line, then run this from the same directory, with `<file>` replaced by that file's path:",
    "",
    fenced(`but pr new ${name} -F <file>`),
    "",
    "   GitButler pushes the branch, and any branches below it in its stack, first.",
    "4. Reply with the PR URL.",
    "",
    "Do not commit, amend, rename, or otherwise change any branch. If `but pr new` fails, report its error and stop.",
  ].join("\n");
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
  return [
    "Resolve the conflicts in one GitButler workspace. Run these from the repository, exactly as quoted:",
    "",
    fenced(`cd ${quote(repositoryPath)}\nbut status`),
    "",
    "`but status` marks conflicted commits and conflicted uncommitted files `{conflicted}`. A conflicted commit can also read `(no changes)`: it is not empty. Resolve every one. If none is left, say so and stop.",
    "",
    '1. Conflicted uncommitted files first: `but resolve apply` fails with "unresolved conflicts exist in the index" while any is left. Edit each to the content it should have, every conflict marker gone, then mark it resolved with `but resolve <path>`. In these files `ours` is the uncommitted edit and `theirs` the incoming change. The markers show no base; `git show :1:<path>` prints it.',
    "2. Conflicted commits, oldest first in each stack, since resolving a commit rebases the commits above it. Name each by the id `but status` shows beside it: it stays the same across applies, though the hash changes. Not by branch: in a stack, a branch name means the oldest conflicted commit of the whole stack.",
    "   - `but resolve conflicts <id>` shows the commit's conflicts, numbered per file. `ours` is the new base the commit was rebased onto, `base` the common ancestor, and `theirs` the commit's own version. Read the sides there: until the commit is resolved, the working tree does not show its version.",
    "   - Write the lines that keep what each side meant to do, and apply them with `but resolve apply <path>:<N> --commit <id>`, on stdin or in `--file <file>`. They replace only that conflict's region, not the whole file, so pass just those lines, with no conflict markers, and do not repeat lines shown around the region, such as a closing brace. A whole file is accepted and duplicates code. `--ours` or `--theirs` instead takes one side whole.",
    "   - The numbers shift after every apply, so list the conflicts again before the next one.",
    "   - A commit is done when `but status` no longer marks it `{conflicted}`.",
    "   - `apply` cannot resolve a deletion, a rename, or a binary or oversized file. Leave such a conflict and go on to the next conflicted commit. For a deletion, `git log --oneline --diff-filter=D -- <path>` helps tell which side deleted the file.",
    "3. Run the repository's quickest check that covers what you changed, such as its typecheck or the tests of those files.",
    "4. Reply with each conflict: what each side wanted, what you kept, and anything you were unsure of. List any conflict `apply` could not resolve and ask whether to resolve it in resolution mode. For a deletion, say which side deleted the file and ask whether the deletion or the commit's change should win.",
    "",
    "Enter resolution mode (`but resolve <id>`) only for a conflict `apply` could not resolve, and only once the user agrees: this working tree is shared with the thread that started you, and resolution mode swaps it out until `but resolve finish`. There, a deleted file comes back in the commit's version and counts as resolved, so delete it before `but resolve finish` if the deletion should win. Do not use `--ai`, and do not follow `but` hints toward resolution mode or toward naming a branch. Do not push, land, commit, or discard anything, and use `but undo` only to take back your own last apply. If a conflict needs a decision only the user can make, ask before applying it.",
  ].join("\n");
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
