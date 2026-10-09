Resolve the conflicts in one GitButler workspace. Run these from the repository, exactly as quoted:

{{status}}

`but status` marks conflicted commits and conflicted uncommitted files `{conflicted}`. A conflicted commit can also read `(no changes)`: it is not empty. Resolve every one. If none is left, say so and stop.

1. Conflicted uncommitted files first: `but resolve apply` fails with "unresolved conflicts exist in the index" while any is left. Edit each to the content it should have, every conflict marker gone, then mark it resolved with `but resolve <path>`. In these files `ours` is the uncommitted edit and `theirs` the incoming change. The markers show no base; `git show :1:<path>` prints it.
2. Conflicted commits, oldest first in each stack, since resolving a commit rebases the commits above it. Name each by the id `but status` shows beside it: it stays the same across applies, though the hash changes. Not by branch: in a stack, a branch name means the oldest conflicted commit of the whole stack.
   - `but resolve conflicts <id>` shows the commit's conflicts, numbered per file. `ours` is the new base the commit was rebased onto, `base` the common ancestor, and `theirs` the commit's own version. Read the sides there: until the commit is resolved, the working tree does not show its version.
   - Write the lines that keep what each side meant to do, and apply them with `but resolve apply <path>:<N> --commit <id>`, on stdin or in `--file <file>`. They replace only that conflict's region, not the whole file, so pass just those lines, with no conflict markers, and do not repeat lines shown around the region, such as a closing brace. A whole file is accepted and duplicates code. `--ours` or `--theirs` instead takes one side whole.
   - The numbers shift after every apply, so list the conflicts again before the next one.
   - A commit is done when `but status` no longer marks it `{conflicted}`.
   - `apply` cannot resolve a deletion, a rename, or a binary or oversized file. Leave such a conflict and go on to the next conflicted commit. For a deletion, `git log --oneline --diff-filter=D -- <path>` helps tell which side deleted the file.
3. Run the repository's quickest check that covers what you changed, such as its typecheck or the tests of those files.
4. Reply with each conflict: what each side wanted, what you kept, and anything you were unsure of. List any conflict `apply` could not resolve and ask whether to resolve it in resolution mode. For a deletion, say which side deleted the file and ask whether the deletion or the commit's change should win.

Enter resolution mode (`but resolve <id>`) only for a conflict `apply` could not resolve, and only once the user agrees: this working tree is shared with the thread that started you, and resolution mode swaps it out until `but resolve finish`. There, a deleted file comes back in the commit's version and counts as resolved, so delete it before `but resolve finish` if the deletion should win. Do not use `--ai`, and do not follow `but` hints toward resolution mode or toward naming a branch. Do not push, land, commit, or discard anything, and use `but undo` only to take back your own last apply. If a conflict needs a decision only the user can make, ask before applying it.
