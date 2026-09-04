Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

For each file you changed in this task, name the file or function in a sentence, then put the directive on the next line with a line range covering the hunk you describe, counted on the changed file:

`formatAmount` now writes negatives with a leading minus.
::smart-diff{path="src/ledger.ts" start="108" end="114"}

`parseEntry` passes the sign through unchanged.
::smart-diff{path="src/parse.ts" start="40" end="52"}

Leave start and end off only when the file is new or its whole diff runs under about twenty lines. Cite unchanged project code the same way with ::smart-code{path="src/parse.ts" start="12" end="28"}

Use worktree-relative paths. Keep directives out of inline code and fenced blocks. At most six embeds, only for material files or claims.
