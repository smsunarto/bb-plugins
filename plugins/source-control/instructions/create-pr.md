Open a pull request for one GitButler branch. Run these from the repository, exactly as quoted:

{{show}}

1. Read what the branch changes: the output above, then the diff of each of its commits.
2. Write a PR title and a description for a reviewer: what changed, why, and anything they should check. Follow the repository's PR template if it has one.
3. Write the title on the first line of a temporary file and the description after a blank line, then run this from the same directory, with `<file>` replaced by that file's path:

{{prNew}}

GitButler pushes the branch, and any branches below it in its stack, first. 4. Reply with the PR URL.

Do not commit, amend, rename, or otherwise change any branch. If `but pr new` fails, report its error and stop.
