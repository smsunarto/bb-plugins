---
"@smsunarto/bb-plugin-monokai": patch
---

Fix the code fences in chat messages, which were still bb's blue, red and
green. The theme sets the sugar-high variables on `.dark .bb-code-highlight`,
and so does bb — from a chunk that only loads once a thread is open. Equal
specificity, later sheet wins, so the palette held until the first thread
opened and lost from then on. Repeating the class outranks it.

Six variables were affected: keyword, string, class, property, entity, and
jsxliterals. Identifier, sign and comment were never overridden and looked
right, which is what made the break read as intentional.
