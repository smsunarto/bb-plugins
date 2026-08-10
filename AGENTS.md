# bb-plugins

Bun-workspace monorepo of personal bb plugins under `plugins/*`. One lockfile, one hoisted `node_modules`. This repo is developed almost entirely by coding agents — keep this file accurate when conventions change.

## Commands

| Command | Effect |
|---|---|
| `bun install` | Install everything (one hoisted `node_modules`). |
| `bun run build` | Build every plugin (`bb plugin build`). |
| `bun run typecheck` | Type-check every plugin. |
| `bun run lint` / `bun run lint:fix` | Oxlint. |
| `bun run test` | Run tests; only plugins that define a `test` script run. |
| `bun run --filter './plugins/<name>' <script>` | Any script for one plugin. |
| `bun run sdk-types:check` | Verify vendored SDK `.d.ts` files match the pinned bb release. |
| `bun run sdk-types:refresh` | Regenerate vendored SDK `.d.ts` files from the pinned bb release. |
| `bun run build:reload` | Build everything, then reload the workspace plugins installed in the running bb. |
| `bb plugin dev plugins/<name>` | Watch one plugin, hot-reload its frontend. |
| `bb plugin logs <id> -f` | Follow one plugin's backend log. |

The pinned bb release lives in root `package.json` → `config.bbVersion`. Locally `bb` comes from the desktop app; CI installs the same version from the `bb-app` npm package. The scripts fail if the CLI version does not match the pin.

## Layout and invariants

- Plugin id = manifest `name` minus the `bb-plugin-` prefix. The directory name is irrelevant.
- `bb plugin build` is the authoritative build. `dist/` is generated and git-ignored — never edit or commit it.
- Plugins are installed into bb as local **path sources**: bb reads files in place. Anything a plugin imports at build time must resolve from the plugin directory via the workspace `node_modules`.
- `types/bb-plugin-sdk.d.ts` and `types/bb-plugin-sdk-app.d.ts` in each plugin are **generated** from the pinned bb release. Never hand-edit them. After a bb upgrade: bump `config.bbVersion`, run `bun run sdk-types:refresh`, and keep each manifest's `engines.bb` / `engines.bbPluginSdk` aligned. `types/css-modules.d.ts` is hand-maintained.
- `components/ui/`, `lib/`, and `hooks/` are vendored shadcn-model source each plugin owns. Edit them freely; the copies are currently identical across plugins but divergence is allowed and deliberate — do not build machinery that assumes byte equality.
- The root `package.json` `overrides` entry replacing `@ampcode/cli` with the stub in `plugins/amp/vendor/` is load-bearing (rationale in the root `comments` field). Never remove or relocate it; `plugins/amp/test/cli-stub.test.ts` guards it.
- Declare runtime imports (for example `zod` in `server.ts`) in `dependencies`, not `devDependencies`. Repo-wide tools (`typescript`, `oxlint`) stay at the root.
- `plugins/amp` pins zod v3 to match its ACP/`@ampcode/sdk` stack. Do not "align" it with the other plugins' zod v4.

## Testing and verification

- `bun run test` fans out across plugins; amp uses `node --test` and that is fine — do not rewrite it for runner uniformity.
- The `@bb/plugin-sdk/testing` vitest harness is documented in the bb plugin-authoring skill but is **not distributable in bb 0.35.x** (no npm package). Until it ships, verify UI plugins with the live loop: `bun run build:reload` (or `bb plugin dev plugins/<name>`), exercise the surface in bb, and check `bb plugin logs <id> -f`.
- Keep pure logic in plain modules so it stays unit-testable without a bb server.

## Conduct

- Do not commit or push unless asked. Preserve unrelated changes.
- Nested `AGENTS.md` files (for example `plugins/pr-walkthrough/AGENTS.md`) add plugin-specific rules and take precedence within their scope.
