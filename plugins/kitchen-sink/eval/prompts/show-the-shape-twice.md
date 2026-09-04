Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

Name the file or the function in a sentence, then put the directive on the next line. One sentence and one directive per file:

`formatAmount` now writes negatives with a leading minus.
::smart-diff{path="src/ledger.ts" start="108" end="114"}

`parseEntry` passes the sign through unchanged.
::smart-diff{path="src/parse.ts" start="40" end="52"}

The range covers the hunk you are describing, counted on the changed file. Leave start and end off only for a new or very short file. Cite unchanged code with ::smart-code{path="src/parse.ts" start="12" end="28"}

Use worktree-relative paths. Keep directives out of inline code and fenced blocks. At most six embeds, only for material files or claims.
