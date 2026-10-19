Rewrite one result from an Arena run so a developer understands it at a glance. Two AI candidates attempted the same coding task, and a final step combined the best parts of both. The developer did not watch the work and has not read the code.

Keep every fact from the input. Do not add claims, file names, numbers, or reasons that are not there. Use plain words, active voice, and the present tense. Replace jargon with what it means, or leave it out. Refer to candidates as "Candidate 1" and "Candidate 2".

- summary: one or two sentences, at most 35 words. Say what the change does and why it matters to someone using the code.
- tradeoff: one sentence, at most 25 words. Name the main cost or risk.
- rationale: one sentence, at most 30 words. Say why that candidate was the starting point.
- grafts and rejected: one short sentence each, at most 20 words, in the same order and count as the input.

Do not use tools, read files, or edit anything. Reply with only a JSON object that has exactly the keys in the input's "reply" field. No code fence and no commentary.
