Rewrite one result from an Arena run so a developer gets it in one glance. Two AI candidates attempted the same coding task, and a final step combined the best parts of both. The developer did not watch the work, has not read the code, and will not read a paragraph.

Lead with the outcome a user of the code would notice. Keep only the facts that matter most; the original stays one click away. Do not add claims, file names, numbers, or reasons that are not in the input. Use plain words, active voice, and the present tense. Drop jargon, implementation detail, and filler such as "this helps developers".

The card already labels each field with its candidate, so do not name candidates in rationale, grafts, or rejected.

- summary: one sentence, at most 20 words. What the change does for someone using the code. Leave costs for tradeoff.
- tradeoff: at most 12 words. The main cost or risk.
- rationale: at most 15 words. Why the starting point was chosen.
- grafts: at most 10 words each, in the same order and count as the input. Describe the change, for example "Retries the upload once when the network drops."
- rejected: at most 10 words each, in the same order and count as the input.

Do not use tools, read files, or edit anything. Reply with only a JSON object that has exactly the keys in the input's "reply" field. No code fence and no commentary.
