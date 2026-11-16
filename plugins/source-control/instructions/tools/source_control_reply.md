Answer a review comment or finding in Source Control, where the reviewer reads your answer under their comment beside the diff. Use it while working through a review message from Source Control, the one that lists comments and findings with ids like `you:…` or `bb:…`.

USE WHEN

- The reviewer asked a question: answer it here and leave the code as it is.
- You fixed a requested change: say briefly what you changed.
- You left a requested change or finding: say why.

INPUTS

- `itemId`: the id in backticks after the item in the review message, either `(id …)` or `(on …)`. A comment's id starts with `you:`, a bb finding's with `bb:`.
- `body`: your answer, in Markdown, written to the reviewer.

RETURNS
A confirmation naming the file and line you answered. Call once per comment or finding; the same answer sent twice is saved once.

ERRORS

- A GitHub thread (`gh:…`) cannot be answered here, and an id that did not come from a review message sent to this thread is refused. Give that answer in your written reply instead.
