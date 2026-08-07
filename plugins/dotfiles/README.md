# bb-plugin-dotfiles

Browse, edit, render, and sync a dotfiles repo from a bb panel.

## Requirements

The plugin does not scan an arbitrary repo. It shows a fixed list of tweakable
files and runs a fixed list of tasks, so it expects a repo with this shape:

| Expectation | Used for |
|---|---|
| A `.dotfiles/` subdirectory | Agent config, seed settings, shell files |
| `mise.toml` with `render`, `check*`, and `sync*` tasks | Every button in the panel |
| `git` | The changed-file tree |

A file that the repo does not have is simply absent from the panel, and the
skills and `fish` drop-in lists are discovered at load rather than hardcoded.
A task the `mise.toml` does not define fails when its button is pressed.

To point the plugin at a different layout, edit `STATIC_GROUPS` and `TASKS` at
the top of `server.ts` — that registry is the whole contract.

Tasks run in a login shell. `fish` is preferred and located at run time
(`$SHELL`, then the usual Homebrew, `/usr/local`, and `/usr/bin` paths), with
`/bin/sh` as the fallback.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/dialog @bb/select
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Ship `dist/` (npm tarball or committed for git installs) so
people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required); optional `bb.app` for a frontend.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — supported plugin SDK range (scaffold: `^0.4.1`).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` (and, with `bb.app`, `app.js` /
`app.css` / `app.meta.json`). Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory:

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload dotfiles
```

## Configure

```
bb plugin config dotfiles
bb plugin config dotfiles set repoPath /path/to/your/dotfiles
```

`repoPath` is required and may be absolute or start with `~/`. The path is
resolved on the machine running the bb server.

## Types & API reference

`types/bb-plugin-sdk.d.ts` (and `types/bb-plugin-sdk-app.d.ts` for the
frontend) are the full, bundled BB plugin API — `tsconfig.json` maps
`@bb/plugin-sdk` to them, so your editor and `tsc` see real types with no extra
install. Ask BB to write plugins for you: the `bb-plugin-authoring` skill
documents the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/ymichael/bb>.
