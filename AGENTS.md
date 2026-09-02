# bb-plugins

## Dev loop

- Start `bun run dev` before the first plugin edit. Leave it running.
- Before handoff, run root `typecheck`, `test`, and `lint`. Also run `build` when a manifest, frontend bundle, build input, dependency, or workspace tooling changed.
- Use `clean` only to diagnose stale `dist/`.

## Traps

- A `--filter '@smsunarto/bb-plugin-*'` that matches nothing exits 0.
- A plugin-only typecheck needs `packages/bb-kit-core/dist/`. Run `build:framework` first.
- Do not edit `dist/`.
- Keep `bb.server` and `bb.app` on source. Do not point them at `dist/server.js`.
- The `bb-plugin-` segment in the package name is load-bearing. The directory name is not identity.
- Put runtime imports in `dependencies`.
- Drive a running bb through the pinned dev instance (`bun run dev:setup`, `scripts/bb-dev-cli`).
- `dist/` is shared between the two instances.
- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Point `BB_SERVER_URL` at the dev App port, not the Server port.
- Put helpers beside the composition root. `check` treats every `.ts` file in `rpc/`, `command/`, and `tools/` as a wired unit.

## Plugin reloads

- After a plugin change passes dev-instance verification, run `bb plugin reload <id>` against the live bb and confirm it is running.
- Keep `agent-proxy` out of automatic live reloads. Reload it only when the user explicitly asks.
- After each plugin install or reload, immediately tell the user the plugin ID, target (`dev bb` or `live bb`), and result.
- Before handoff, name each target where you did not install or reload the change.
- Close a change by naming what to exercise in bb. Do not tell the user to run plugin build or reload commands.
