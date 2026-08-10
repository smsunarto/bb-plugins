# bb-plugins

Bun-workspace monorepo of personal bb plugins under `plugins/*`. One lockfile, one hoisted `node_modules`. Keep this file accurate when conventions change.

## Development workflow

- **Default during plugin work:** run `bun run dev` once and leave it running. It watches every plugin, rebuilds and reloads only the plugin that changed, and does not create duplicate watchers when run again. Do not prefer a filtered dev command; this repo is small and the all-plugin loop is the standard path.
- **Fast check while editing:** run `bun run --filter 'bb-plugin-<name>' typecheck` or `test` for the plugin you changed. Use this only for iteration speed.
- **Before handoff:** run root `bun run typecheck`, `bun run test`, and `bun run lint`. Also run `bun run build` when the change affects a manifest, frontend bundle, build input, dependency, or workspace tooling. A pure backend logic change with passing typecheck and tests does not need an extra build.
- **Live UI or runtime behavior:** use the existing `bun run dev` loop, exercise the affected surface in bb, and inspect `bun run logs <id> -f` when behavior or reload is unclear.
- **One-shot recovery:** use `bun run reload <id>` only when no dev watcher is running or a plugin needs manual recovery. Use `bun run build:reload` only when you explicitly want one full build-and-reload pass instead of a watcher. Do not run either after each edit.
- **Dependencies:** run `bun install` after a fresh checkout or after package or lockfile changes, not as a routine verification step.
- **Generated SDK types:** use `bun run sdk-types:check` in bb-version work. Use `bun run sdk-types:refresh` only after changing the pinned bb version; never refresh generated types to fix an ordinary type error.
- **Clean builds:** use `bun run clean` only to diagnose stale generated output or to prove a clean build. Do not delete `dist/` during the normal live loop.

The pinned bb release lives in root `package.json` → `config.bbVersion`. Locally `bb` comes from the desktop app; CI installs the same version from the `bb-app` npm package. The scripts fail if the CLI version does not match the pin.

## Layout and invariants

- Use the hybrid package-name convention: installable bb plugins are `bb-plugin-<id>`; shared non-plugin packages are `@smsunarto/<name>`.
- Plugin id = manifest `name` minus the `bb-plugin-` prefix. Keep its directory at `plugins/<id>` for navigation, although bb does not use the directory name as identity.
- Put shared non-plugin packages in `packages/<name>` when needed. Do not give a bb plugin an `@smsunarto/*` name because bb derives its id from the `bb-plugin-` prefix.
- `bb plugin build` is the authoritative build. `dist/` is generated and git-ignored — never edit or commit it.
- Plugins are installed into bb as local **path sources**: bb reads files in place. Anything a plugin imports at build time must resolve from the plugin directory via the workspace `node_modules`.
- `types/bb-plugin-sdk.d.ts` and `types/bb-plugin-sdk-app.d.ts` in each plugin are **generated** from the pinned bb release. Never hand-edit them. After a bb upgrade: bump `config.bbVersion`, run `bun run sdk-types:refresh`, and keep each manifest's `engines.bb` / `engines.bbPluginSdk` aligned. `types/css-modules.d.ts` is hand-maintained.
- `components/ui/`, `lib/`, and `hooks/` are vendored shadcn-model source each plugin owns. Edit them freely; the copies are currently identical across plugins but divergence is allowed and deliberate — do not build machinery that assumes byte equality.
- The root `package.json` `overrides` entry replacing `@ampcode/cli` with the stub in `plugins/amp/vendor/` is load-bearing (rationale in the root `comments` field). Never remove or relocate it; `plugins/amp/test/cli-stub.test.ts` guards it.
- Declare runtime imports (for example `zod` in `server.ts`) in `dependencies`, not `devDependencies`. Repo-wide tools (`typescript`, `oxlint`) stay at the root.
- `plugins/amp` pins zod v3 to match its ACP/`@ampcode/sdk` stack. Do not "align" it with the other plugins' zod v4.

## Testing and verification

- Root build, dev, typecheck, and clean scripts fan out through Bun's `bb-plugin-*` workspace filter. Root tests cover workspace scripts before the plugin suites. Dev scripts use `scripts/dev-plugin.ts` for one polling watcher per plugin directory and stale-lock recovery. Amp uses `node --test` and that is fine — do not rewrite it for runner uniformity.
- The `@bb/plugin-sdk/testing` vitest harness is documented in the bb plugin-authoring skill but is **still not distributable at bb 0.36.0**. Re-verified 2026-08-09, so do not re-litigate it: `@bb/plugin-sdk` 404s on npm and the whole `@bb` scope is empty; GitHub Packages has nothing under that owner; the `bb-app` tarball ships only the host-side `plugin-sdk-runtime.js`, not the package; bb's sole publish workflow publishes `packages/bb-app` alone; and `bb plugin new --app` vendors only the `types/*.d.ts`, no vitest and no harness. Upstream examples reach it via `"@bb/plugin-sdk": "workspace:*"`, which a fork cannot resolve, and no package manager can install a subdirectory of a git monorepo. Until it ships, UI verification means the live loop plus a real surface check; build success alone is insufficient.
- Keep pure logic in plain modules so it stays unit-testable without a bb server.

## Conduct

- Do not commit or push unless asked. Preserve unrelated changes.
- Nested `AGENTS.md` files (for example `plugins/pr-walkthrough/AGENTS.md`) add plugin-specific rules and take precedence within their scope.
