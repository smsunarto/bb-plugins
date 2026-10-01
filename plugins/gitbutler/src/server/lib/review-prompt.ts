/**
 * What the PR subthread is told. The agent reads the branch, writes the
 * title and description, and lets GitButler push and open the review, so the
 * description is written by something that read the diff.
 *
 * Git allows `;`, `$`, and backticks in branch names, so the branch and path
 * only ever appear shell-quoted inside fenced commands, never as prose.
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
