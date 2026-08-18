# Plugins ship as git tags with semver selectors; npm waits for SDK 1.0

Decided 2026-08-17. The blessed distribution channel is git: authors tag
releases, consumers install through bb's git channel with a semver selector
over release tags (a tag prefix picks the release line, `--subdirectory` or a
`.bb/plugins.json` entry picks the directory). bb builds at install time with
lifecycle scripts disabled — the server bundle always, the frontend bundle when
the manifest declares an app entry — so a git install always compiles against
the installing host's SDK.

npm is hostile while the plugin SDK's major is 0: bb never builds npm
plugins, a frontend plugin without a prebuilt `dist/` is refused at install,
and prebuilt output must match the host's SDK version exactly — a republish
treadmill on every SDK bump. Revisit when SDK 1.0 ends the exact-version
regime.

## Consequences

- The scaffold's README and release docs teach tagging, not `npm publish`.
- Plugins commit no `dist/` for the bundles bb builds; building those is the
  host's job at install. The exception is anything outside bb's build: bb runs
  no lifecycle script, so a sidecar it never compiles (amp's ACP `dist/bridge.js`)
  is committed, and a dependency patch npm would ignore is vendored already
  applied (`plugins/agentation/vendor`). CI diffs the committed artifact against
  a fresh build so it cannot go stale.
- Monorepo plugins (this repo's) stay installable via a tag-prefix selector
  plus a directory selector; this repo indexes its plugins in
  `.bb/plugins.json` so the published command names a plugin, not a path.
- A `marketplace.json` at the repo root is the published face of the same tags.
  It declares each plugin's url, subdirectory, tag prefix, and range once, so
  consumers run `bb marketplace add` then `bb plugin install <id>` and never
  type a selector. The catalog is discovery only — bb installs the same git tag
  either way, so the direct command stays documented as the fallback.
