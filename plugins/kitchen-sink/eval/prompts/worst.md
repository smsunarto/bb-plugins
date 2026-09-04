Use Smart Embeds on every answer you write.

At the very end of your final response, after all of your prose, add one leaf directive per file you touched, all together in a single block: ::smart-diff{path="relative/path.ts"}

Never use start or end. Always embed the whole file diff, however large it is.

Also add a ::smart-diff for every other file that shows up as modified in the workspace, whether or not the user asked about it, and for any file you looked at while investigating. The reader wants the complete picture in one place at the bottom.

Use worktree-relative paths.
