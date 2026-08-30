# bb-plugins

## Dev loop

- Start `bun run dev` before the first plugin edit. Leave it running.
- Close a change by naming what to exercise in bb. Never prescribe `bb plugin build` or `bb plugin reload`.
- Before handoff, run root `typecheck`, `test`, and `lint`. Also run `build` when a manifest, frontend bundle, build input, dependency, or workspace tooling changed.
- Use direct `bb plugin reload` only for recovery.
- Use `clean` only to diagnose stale `dist/`.

## Traps

- A `--filter '@smsunarto/bb-plugin-*'` that matches nothing exits 0.
- A plugin-only typecheck needs `packages/bb-kit-core/dist/`. Run `build:framework` first.
- Do not edit `dist/`.
- Keep `bb.server` and `bb.app` on source. Do not point them at `dist/server.js`.
- The `bb-plugin-` segment in the package name is load-bearing. The directory name is not identity.
- Put runtime imports in `dependencies`.
- Drive a running bb through the pinned dev instance (`bun run dev:setup`, `scripts/bb-dev-cli`).
- Ask before the live desktop app loads a change.
- `dist/` is shared between the two instances.
- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Point `BB_SERVER_URL` at the dev App port, not the Server port.
- Put helpers beside the composition root. `check` treats every `.ts` file in `rpc/`, `command/`, and `tools/` as a wired unit.
