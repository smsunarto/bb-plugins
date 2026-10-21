# Opening a PR

Commit and PR shape, once publishing is authorized. Repository and session conventions for version control and PR descriptions come first; this is the fallback.

**Commits.** Commit as you go, then tidy into small, ordered commits before opening a PR. Each commit should be landable and tell part of the story. Amend when a fix belongs in a just-made commit; make a new commit when it's separable. Commit bodies don't need to restate the subject.

**Titles.** Conventional Commits `type(scope): subject` with no trailing period. The type is something like `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. The scope is the area. The subject is short and imperative, and names a real symbol when one carries the change.

**Descriptions.** Write a one-minute briefing for a reviewer who has the diff, not a lab notebook. The `technical-writing` and `unslop` skills help with the prose. These `##` sections work well, in this order, skipping any with nothing to say:

- `## Why`: the problem and approach in one to three sentences.
- `## What changed`: one to three bullets. Name a symbol or path only when it carries the change, and name both sides of a rename.
- `## Scope`: what it covers and what it deliberately leaves out.
- `## Tradeoffs`: only alternatives a reviewer would otherwise ask about.
- `## Blast Radius`: who or what it touches, and why that's safe or risky.
- `## Verification`: one to three real run paths and their outcomes. For perf, one primary number as `before → after` with its unit.

Attach screenshots or videos when they prove a claim. Full SHAs, file-by-file checklists, and long run logs belong in a linked artifact rather than the body. Since the body often becomes the squash commit body, keep it under about 40 lines.
