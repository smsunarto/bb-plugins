# bb-plugins

## Dev loop

- Start `bun run dev` before the first plugin edit. Leave it running.
- Close a change by naming what to exercise in bb.
- Do not tell the user to run `bb plugin build` or `bb plugin reload`.
- For a fast check, run `bun run --filter '@smsunarto/bb-plugin-<id>' typecheck` or `test`.
- Before handoff, run root `typecheck`, `test`, and `lint`.
- Run `build` when the change touches a manifest, frontend bundle, build input, dependency, or workspace tooling.
- Use `bun run reload <id>` and `build:reload` only for recovery.
- Run `bun install` after a checkout or a lockfile change.
- Run `bun run clean` only to diagnose stale `dist/`.

## Traps

- A `--filter '@smsunarto/bb-plugin-*'` that matches nothing exits 0.
- A plugin-only typecheck needs `packages/bb-kit-core/dist/`. Run `build:framework` first.
- Do not edit `dist/`.
- Keep `bb.server` and `bb.app` on source. Do not point them at `dist/server.js`.
- The `bb-plugin-` segment in the package name is load-bearing. The directory name is not identity.
- Put runtime imports in `dependencies`.
- Do not remove or move the root `@ampcode/cli` override.
- Drive a running bb through the pinned dev instance (`bun run dev:setup`, `scripts/bb-dev-cli`).
- Ask before the live desktop app loads a change.
- `dist/` is shared between the two instances.
- When you capture plugin screenshots, follow the `bb-plugin-screenshots` skill.
- Point `BB_SERVER_URL` at the dev App port, not the Server port.

## Agent docs

- Issues in `.scratch/<feature>/`: `docs/agents/issue-tracker.md`
- Triage labels: `docs/agents/triage-labels.md`
- Domain language: `CONTEXT-MAP.md` and `docs/agents/domain.md`
