# bb-plugins

## Setup

- Start `bun run dev` before the first plugin edit. Leave it running.
- Author every new plugin with the bb-kit framework (`@bb-kit/core`).

## Environment

- By default, running `bb` commands points to the user's live bb instance. Run `bb --version` to see what bb version the user have installed.
- **Spawning isolated dev bb instance** - Run `bun run dev:instance`

### Verification

Read `.agents/skills/verify-bb-plugins`

- Plugin changes shouldn

#### Agent-driven testing

- Prepare plugin development with `bun run dev:instance`. Route one bb command with `bb-kit dev-instance exec --`.

### Handoff

Do this before you end your turn and handoff to the user:

- If modifying an existing plugin (after a plugin change passed dev-instance verification):
  - Run `bb plugin source <id>` and make sure bb is loading the plugin from the correct local path instead of NPM installation, etc. If it's not, reinstall the plugin using local path source.
  - Then, use `bb plugin reload <id>` against the live bb and confirm it is running. Do not this for `agent-proxy`: reload it only when the user explicitly asks.
- If creating a new plugin:
  -
- Explicitly state whether your work has been committed or remains uncommitted.
- Run root `typecheck`, `test`, and `lint`. Also run `build` when a manifest, frontend bundle, build input, dependency, or workspace tooling changed.
- Remove any stray docs that is produced during yoru work.
- If a plugin was installed or reloaded: insert a heading `Plugin Reloaded` with a bullet list of target plugins.

## Traps

-
- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Do not point `BB_SERVER_URL` at the dev App port, point it the Server port.
- Do not put helpers beside the composition root. `check` treats every `.ts` file in `rpc/`, `command/`, and `tools/` as a wired unit.
