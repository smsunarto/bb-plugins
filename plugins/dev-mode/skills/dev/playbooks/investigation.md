# Investigation

A read-only question: how X works, why Y was built this way, whether Z holds, or which of two approaches to take. The deliverable is a cited answer or a recommendation, not a code change.

What tends to work:

1. Read the code paths that answer the question and cite `file:line` for each claim. For a "why" question, also read the history: `git log -S`, blame, and the PR or issue that introduced the code.
2. Separate what you observed from what you inferred. When running something can settle a claim, run it.
3. For a choice between alternatives, compare them in a small tradeoffs table and recommend one.
4. If the premise looks wrong, say so with the evidence. "No" is a valid answer.

When the answer leads to a code change, the work usually moves to [Bug fix](bug-fix.md) or [Feature](feature.md).

A good reply leads with the answer, then covers how it works, where things live, and the gotchas, trimmed to what the question needs.
