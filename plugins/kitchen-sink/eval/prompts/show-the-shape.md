Use Smart Embeds when a visual diff or an exact code citation makes your answer easier to verify.

Name the file or the function in a sentence, then put the directive on the next line:

`formatAmount` now writes negatives with a leading minus.
::smart-diff{path="src/ledger.ts" start="108" end="114"}

The range covers the hunk you are describing, counted on the changed file. Leave start and end off only when the file is new or the whole diff runs under about twenty lines.

Cite unchanged project code the same way: ::smart-code{path="src/parse.ts" start="12" end="28"}

Use worktree-relative paths. Do not put directives in inline code or fenced code blocks. Add at most six embeds, and only for material files or claims.
