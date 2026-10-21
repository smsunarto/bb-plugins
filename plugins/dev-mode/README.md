# Dev Mode

Arena, independent review, engineering skills, and shared engineering principles for BB. Arena and review are prompts, not tools: the plugin injects `instructions/author.md` into author threads and ships the `arena` and `review` skills.

## Arena and review

Both ask one Claude and one Codex child thread the same prompt. The agent starts each child with the `bb thread spawn --parent-self` recipe in `instructions/author.md`. BB messages the parent as each child finishes, and the parent reads the answers with `bb thread output <thread-id>`.

- **Arena** asks a question when the user wants two independent answers. The parent weighs them.
- **Review** runs at implementation handoff and before consequential designs. Reviewers read `git diff <base> <head>` in the parent's checkout and apply the lenses under `skills/review/references/`, which the parent pastes into their prompt. The parent judges the findings, fixes accepted ones, and reruns checks.

Children are asked not to edit, commit, or start threads; nothing enforces it. A child with a parent and an `Arena (Claude|Codex)` or `Review (Claude|Codex)` title gets no skills or instructions, so it cannot follow them into starting more children. BB itself shows their status, retries, and history.

Side chats, BB's review plugin threads, and threads this plugin launched before it switched to prompts get no skills or instructions.

## Commands

- `bb dev-mode principle` lists shared principles; add `--name grug-brain` to read one.

The injected prompt and the principle command text are editable under `instructions/`. Skills and their references are bundled under `skills/`. Engineering principles live in `references/principles/`. The `principle` command reads them from the installed plugin without adding skill catalog entries.

## Maintaining imported prompts

Preserve imported principles, skills, and supporting prompts verbatim wherever possible. Limit porting changes to requested renames, reference paths, unavailable integrations, and required BB adapters. Do not paraphrase, simplify, or change behavior as incidental cleanup; treat intentional prompt changes as behavior changes requiring explicit rationale.

The existing skills and principle references come from [Scott's dotfiles fork before migration](https://github.com/smsunarto/dotfiles/tree/9bd2820707a2a1f4525bccd32af9766cb98c1d6a/.dotfiles/.agents/plugins/scott-engineering).

The package identity remains `@smsunarto/bb-plugin-scott-engineering` (BB id `scott-engineering`) so existing settings and thread metadata stay in their original namespace. The display name, source directory, catalog entry, and CLI (`bb dev-mode`) use the new name. In `src/server/server.ts`, `pluginId` keeps the stored id and bb-kit's `publicName` supplies the CLI name.
