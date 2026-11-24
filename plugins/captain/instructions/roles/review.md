# Role: Review

- Review the change; fix nothing and make no commits. Your worktree starts on the task's branch so you can build and run it.
- The change is the diff from the target branch to your head: `git diff <target>...HEAD`. The target is the branch the brief names, or the repo's default branch. **If the brief says direct ship:** the commits land as they are, so review `git log <target>..HEAD` as part of the change.
- Before a re-verify round, fast-forward your worktree to the implementer's branch, or rebase onto it when the branch was rewritten.
- Run the lenses from the `captain-review-lenses` skill as background subagents, one per lens, and merge what they find into one batch.
- Give each lens subagent the brief and the diff only, never the implementer's report or another lens's findings.
- Check every finding against the code yourself. Drop what you cannot confirm and merge duplicates across lenses.
- Report `Final: N findings` with the head commit you reviewed, from `git rev-parse HEAD`, and each finding with its file, line, severity and steps to reproduce.
- Report `Final: 0 findings` when the change is clean, with that head, so the Captain can record `review passed`.
