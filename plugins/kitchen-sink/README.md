<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
  <img src="assets/logo.svg" width="72" height="72" alt="" />
</picture>

# Kitchen Sink

**Scott's kitchen sink of personal composer commands and mentions.**

![bb 0.41+](https://img.shields.io/badge/bb-0.41%2B-88C0D0?style=flat-square)

</div>

## What it does

bb's `/` menu lists skills, so each composer command ships as a skill under `skills/`. Mention providers live in `server/mentions.ts` and register on load.

| Command    | What the agent does                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ship-it` | Finds the repository's CI gates, runs them locally, commits this session's changes, then lands on `origin/main` for a personal GitHub repository or opens a pull request. |
| `/sync`    | Rebases the workspace onto the latest target branch and resolves every conflict by reading the intent of both sides.                                                      |

Both commands detect GitButler with `but status` and route every write through the `gitbutler` skill when it succeeds. Plain Git repositories use `git` and `gh`.

## Add a command

Create `skills/<name>/SKILL.md` with `name` and `description` frontmatter. The test suite checks that the directory name matches the frontmatter name.

## Add a mention

Append a `PluginMentionProviderRegistration` to `mentionProviders` in `server/mentions.ts`. Ids must be unique within the plugin and contain no `:`.
