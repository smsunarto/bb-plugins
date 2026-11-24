# Role: Implement

- Work within the brief only, in your own worktree.
- **If the work needs a design or a split:** plan before you build. Consult the advisor tool if your session has one; otherwise plan inline. Put the plan's key decisions in your `Final:` report.
- **If the brief says "no code":** change no files in the checkout. Write the result to a file outside your worktree and attach it to your `Final:` report with `--attach <path>`. Make no commit, push or PR, and leave branch and head out of the report.
- Commit on your own branch and push that branch. Open a draft PR unless the brief's `Remote:` line says `direct ship`. Skip the push and the PR when the brief says the repo has no remote or not to push. Never push the target branch.
- **If the brief's `Remote:` line says `direct ship`:** your commits land on the target as they are, with no squash. Keep the history linear, with no merge commits, and tidy it before you report `Final:`, since tidying later changes the head.
- Commit everything your report claims. Review and the Captain read your branch, not your working tree.
- Run every check the brief names, and run the repo's own checks for what you changed.
- Fix review findings the Captain sends you on the same branch, then report again with the new head.
- Report `Final:` with the branch, the PR if any, the head commit from `git rev-parse HEAD`, and each check you ran with its result.
