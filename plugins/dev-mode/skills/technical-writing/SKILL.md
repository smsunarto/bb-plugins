---
name: technical-writing
description: Write or review technical docs, RFCs, readmes, PR descriptions, and commit messages for clear purpose, precise claims, and readable prose.
---

# Technical writing

Write for the reader's task and existing knowledge. Preserve useful constraints, evidence,
and uncertainty while removing repetition and explanation the reader does not need.
Use the codebase's real symbols, paths, flags, and commands.

For agent skills, the installed Codex `skill-creator` owns instruction design and scope.
Use this skill for prose clarity without overriding that writing authority. Product UI
strings follow the product's copy conventions.

## Organize around the reader's purpose

Diátaxis provides a useful distinction when a document set needs structure:

| Purpose                         | Useful form                                    |
| ------------------------------- | ---------------------------------------------- |
| Learn through a guided task     | Tutorial with visible intermediate results     |
| Complete a known task           | How-to with prerequisites and relevant choices |
| Look up behavior or options     | Reference organized like the thing described   |
| Understand a design or tradeoff | Explanation with context and rationale         |

Separate substantial material serving different purposes when that makes navigation easier.
A short document can include a reference table or brief rationale without becoming several
files. Do not impose a documentation taxonomy on a commit message or a small note.

## Make actions and claims precise

- State who does what. Use commands for procedures and place a necessary condition before
  the action it governs. Passive voice is useful when the actor does not matter.
- Keep names consistent. Repeat a noun when a pronoun could refer to several things, and
  put words such as "only" next to what they qualify.
- Preserve articles, verbs, and conditions. Brevity should not make the reader decode
  fragments or guess how a list of conditions groups.
- Prefer literal language and familiar words. Use an established technical term when it
  is more precise, and explain it if the audience needs that explanation.
- Split a sentence when its instructions or clauses compete. Keep a longer sentence when
  its condition and consequence are clearer together. Do not enforce word-count limits.
- Distinguish verified facts, assumptions, proposals, and unavailable evidence. A style
  preference for direct language does not justify false certainty.

Use sentence-case headings, numbered steps for a real sequence, and bullets for parallel
items. Link with a descriptive title. Format code as code and follow the language or
repository's snippet conventions. Prefer periods over semicolons and em dashes.

## Review the deliverable

Apply [Unslop](../unslop/SKILL.md) to remove filler and mannered phrasing while preserving
meaning and the requested tone. That skill owns its stable pattern catalog. Do not expand
a writing task into changes to the catalog or other policy files.

Scale PR and commit descriptions to the change. Lead with the concrete problem and resulting
behavior, then include the decision and verification details a reviewer needs. Link lengthy
logs or measurements when relevant rather than pasting a work diary.

Verify symbols, paths, commands, and material quantitative claims against the available
source. Include a reproduction command when the reader needs to repeat a measurement.
A simple wording edit does not require generating new evidence artifacts.

## Source background

The conventions above draw on these sources, recorded as consulted on 2026-07-18. They
are writing guidance, not a claim of formal compliance with any standard.

- [Diátaxis](https://diataxis.fr) for document purpose.
- [Google developer documentation style](https://developers.google.com/style) for reader-facing procedures.
- [ASD-STE100](https://asd-ste100.org), Issue 9 (2025), for clear instructions.
- Kohl, _The Global English Style Guide_ (SAS Press), for unambiguous syntax. The earlier
  source notes identify the Internet Archive and SAS sample chapter.
