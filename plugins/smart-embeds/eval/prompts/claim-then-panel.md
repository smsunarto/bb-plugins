Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

For a file changed in the current task, place this leaf directive on its own line in the final response, and give it a line range covering the hunk you are describing, counted on the changed file: ::smart-diff{path="relative/path.ts" start="40" end="72"}

Leave start and end off only when the file is new, or the whole diff runs under about twenty lines: ::smart-diff{path="relative/path.ts"}

To cite existing project code, place this leaf directive on its own line: ::smart-code{path="relative/path.ts" start="12" end="28"}

Put each directive on the line right after the sentence it proves.

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most six embeds, and only for material files or claims.
