# bb-plugins

## Dev Commands

- Start `bun run dev` if there isn't one running.
- Lint: `bunx oxlint --fix --format=agent`
- Formatting: `bunx oxfmt`.

## Dev Preferences

- Author every new plugin with the bb-kit framework (`@bb-kit/core`).
- If something can be done through bb-plugin, do it through bb-plugin. If it's possible through bb-plugin, but it is hacky (no easy way to do it via the bb SDK, flag it to the user for approval first).
- If an implementation is ONLY possible through modification of bb's core app, flag to the user for approval first. DO NOT start work on bb core app without explicit approval.
- UI components: https://ui.shadcn.com
- Code diffs, syntax highlighting: https://diffs.com
- Prefer to use an existing color palette from `/plugins/monokai` theme. If a new color is needed, it should be added to the theme before being used. This is so that when we update the theme, the color change is applied to all plugins that use it.
- Always check whether the SDK provides an API that can be used to achieve the desired functionality before handrolling our own solution.
- Keep agent-facing text (thread instructions, prompts, tool descriptions) in `<plugin>/instructions/` and read it with `instructionFiles` from `@bb-kit/core/instructions`. Tool descriptions go in `instructions/tools/<tool>.md`, with an optional `<tool>.instructions.md` thread snippet. The Prompt Editor plugin edits these files, so do not inline agent text in code.

## Work -> Plugins Routing

- Prefer to group work into an existing relevant plugins. Obtain explicit approval before creating a new plugin.
- Styling, themes, bb UI: `/plugins/monokai`
- Left sidebar: `/plugins/gtd-sidebar`
- Misc. Catch-all: `/plugins/kitchen-sink`

## Catalogs

`marketplace.json` (repo root) is the public catalog `bb marketplace add` reads. `.bb/plugins.json` is the collection index `bb plugin install --plugin` reads. They are not interchangeable, and bb will not look for `marketplace.json` under `.bb/`.

When you add, rename, or remove a catalog plugin, update both files in the same change: every `marketplace.json` `id` needs a matching `.bb/plugins.json{ "name", "source": "./plugins/<id>" }`. Leave unpublished personal plugins out of `marketplace.json`. `.bb/plugins.json` may list those extras.

## Environment

- By default, running `bb` commands points to the user's live bb instance. Run `bb --version` to see what bb version the user have installed.
- Reuse the workspace development instance. Run `bun run dev:instance` if it is not prepared.

### Verification

Use BB's bundled `bb-plugin-authoring` skill and its `references/testing.md` for SDK tests and the live plugin loop.

- Run focused tests with `@get-bb/plugin-sdk/testing`, `/testing/app`, or `/testing/host` for the affected contracts.
- Reuse the workspace development instance and its existing watcher. Do not launch a fresh BB stack for each verification run.
- Read the instance's app URL, server URL, and data directory from `bb-kit dev-instance status --json`. Route CLI commands through `bb-kit dev-instance exec --` so they target that instance.
- Use the routed `bb plugin dev` loop when the affected plugin is not already watched. Inspect its source, status, logs, or RPC with BB's plugin commands.
- Verify the changed user flow in a browser when rendering or host integration matters. Capture and inspect evidence, remove this run's test records, and close only its browser session.
- Use an additional isolated instance only when a check needs separate state. Verify its processes and listeners stop after cleanup; leave the workspace instance running.

For plugin UI performance investigations, read `.agents/skills/bb-plugin-performance/SKILL.md`.

### Handoff

If modifying an existing plugin (after focused checks and the affected live user flow pass):

- Run `bb plugin source <id>` and make sure bb is loading the plugin from the correct local path instead of NPM installation, etc. If it's not, reinstall the plugin using local path source.
- Always use `bb plugin reload <id>` against the live bb and confirm it is running before handoff.
- If the plugin cannot be reloaded, explicitly state that it was not reloaded and explain the blocking reason to the user. Never silently skip the reload.

If creating a new plugin:

- Run `bb plugin install [options] <source>` pointing at the user's live bb instance.

When communicating the handoff:

- Explicitly state whether your work has been committed or remains uncommitted.
- If a plugin was installed or reloaded: insert a heading `Plugin Reloaded` with a bullet list of target plugins.

## Traps

- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Do not point `BB_SERVER_URL` at the dev App port, point it the Server port.
- Do not put helpers beside `src/server/server.ts`. `check` treats every `.ts` file in `src/server/rpc`, `src/server/command`, and `src/server/tools` as a wired unit.
